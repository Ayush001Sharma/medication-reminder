from datetime import timedelta

import pytest
from django.utils import timezone

from accounts.models import Role
from conftest import client_for, make_dose, make_user
from notifications import services as notification_services
from scheduling.models import DoseEvent, DoseStatus
from scheduling.views import local_day_window

pytestmark = pytest.mark.django_db


def url(dose, action):
    return f"/api/doses/{dose.id}/{action}/"


# --- GET today / upcoming ---------------------------------------------------------
def test_today_lists_only_my_doses_in_my_local_day(patient, patient_api, other_patient):
    start, end = local_day_window(patient, timezone.now())
    inside = [make_dose(patient, start + timedelta(seconds=1)),
              make_dose(patient, end - timedelta(seconds=1), DoseStatus.TAKEN)]
    make_dose(patient, start - timedelta(seconds=1))  # yesterday (local)
    make_dose(patient, end)  # tomorrow (local midnight is exclusive)
    make_dose(other_patient, start + timedelta(hours=1))

    body = patient_api.get("/api/doses/today/").json()
    assert [d["id"] for d in body] == [d.id for d in inside]
    first = body[0]
    assert first["medication"]["name"] == "Metformin"
    assert first["scheduled_local"].endswith("+05:30")  # patient is Asia/Kolkata
    assert {"status", "taken_at", "taken_late", "reminder_sent_at", "missed_at"} <= set(first)


def test_today_window_uses_patient_timezone_across_dst(db):
    from datetime import UTC, datetime
    ny = make_user("ny@example.com", tz="America/New_York")
    # 2026-03-08 is the 23-hour spring-forward day in New York.
    start, end = local_day_window(ny, datetime(2026, 3, 8, 15, tzinfo=UTC))
    assert (start, end) == (datetime(2026, 3, 8, 5, tzinfo=UTC), datetime(2026, 3, 9, 4, tzinfo=UTC))


def test_upcoming_returns_future_open_doses_within_days(patient, patient_api, other_patient):
    now = timezone.now()
    soon = make_dose(patient, now + timedelta(hours=2))
    later = make_dose(patient, now + timedelta(days=5), DoseStatus.REMINDED)
    far = make_dose(patient, now + timedelta(days=8))
    make_dose(patient, now - timedelta(hours=2))  # past
    make_dose(patient, now + timedelta(hours=3), DoseStatus.TAKEN)
    make_dose(other_patient, now + timedelta(hours=2))

    ids = lambda r: [d["id"] for d in r.json()]  # noqa: E731
    assert ids(patient_api.get("/api/doses/upcoming/")) == [soon.id, later.id]
    assert ids(patient_api.get("/api/doses/upcoming/?days=10")) == [soon.id, later.id, far.id]
    assert ids(patient_api.get("/api/doses/upcoming/?days=1")) == [soon.id]


@pytest.mark.parametrize("days", ["0", "31", "abc", "-1"])
def test_upcoming_rejects_bad_days(patient_api, days):
    assert patient_api.get(f"/api/doses/upcoming/?days={days}").status_code == 400


# --- mark taken ---------------------------------------------------------------------
@pytest.mark.parametrize("status", [DoseStatus.PENDING, DoseStatus.REMINDED])
def test_mark_taken_records_taken_at(patient, patient_api, status):
    dose = make_dose(patient, timezone.now(), status)
    before = timezone.now()
    resp = patient_api.post(url(dose, "taken"))
    assert resp.status_code == 200
    dose.refresh_from_db()
    assert dose.status == DoseStatus.TAKEN and before <= dose.taken_at <= timezone.now()
    assert dose.taken_late is False
    assert resp.json()["status"] == "taken" and resp.json()["taken_late"] is False


def test_missed_dose_marked_taken_is_flagged_late_and_keeps_missed_at(patient, patient_api):
    missed_at = timezone.now() - timedelta(hours=1)
    dose = make_dose(patient, timezone.now() - timedelta(hours=3), DoseStatus.MISSED, missed_at=missed_at)
    resp = patient_api.post(url(dose, "taken"))
    assert resp.status_code == 200 and resp.json()["taken_late"] is True
    dose.refresh_from_db()
    assert (dose.status, dose.taken_late, dose.missed_at) == (DoseStatus.TAKEN, True, missed_at)
    assert dose.taken_at is not None


def test_marking_taken_twice_is_idempotent(patient, patient_api):
    dose = make_dose(patient, timezone.now(), DoseStatus.MISSED)
    first = patient_api.post(url(dose, "taken")).json()
    second = patient_api.post(url(dose, "taken"))
    assert second.status_code == 200 and second.json() == first  # same taken_at, still late
    assert DoseEvent.objects.get(pk=dose.pk).taken_late is True


def test_taken_dose_can_not_become_missed(patient, patient_api):
    dose = make_dose(patient, timezone.now() - timedelta(hours=5), DoseStatus.REMINDED)
    patient_api.post(url(dose, "taken"))
    assert notification_services.mark_missed_doses() == 0
    dose.refresh_from_db()
    assert dose.status == DoseStatus.TAKEN and dose.missed_at is None


def test_taken_dose_can_not_be_skipped(patient, patient_api):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    patient_api.post(url(dose, "taken"))
    resp = patient_api.post(url(dose, "skip"))
    assert resp.status_code == 409
    assert DoseEvent.objects.get(pk=dose.pk).status == DoseStatus.TAKEN


def test_skipped_dose_can_not_be_marked_taken(patient, patient_api):
    dose = make_dose(patient, timezone.now(), DoseStatus.SKIPPED)
    assert patient_api.post(url(dose, "taken")).status_code == 409
    assert DoseEvent.objects.get(pk=dose.pk).status == DoseStatus.SKIPPED


# --- skip ---------------------------------------------------------------------------
@pytest.mark.parametrize("status", [DoseStatus.PENDING, DoseStatus.REMINDED])
def test_mark_skipped_and_repeat_is_idempotent(patient, patient_api, status):
    dose = make_dose(patient, timezone.now(), status)
    assert patient_api.post(url(dose, "skip")).json()["status"] == "skipped"
    assert patient_api.post(url(dose, "skip")).status_code == 200
    assert DoseEvent.objects.get(pk=dose.pk).taken_at is None


def test_missed_dose_can_not_be_skipped(patient, patient_api):
    dose = make_dose(patient, timezone.now(), DoseStatus.MISSED)
    assert patient_api.post(url(dose, "skip")).status_code == 409


# --- ownership / auth ------------------------------------------------------------------
@pytest.mark.parametrize("action", ["taken", "skip"])
def test_cannot_act_on_another_patients_dose(patient, other_api, action):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    assert other_api.post(url(dose, action)).status_code in (403, 404)
    dose.refresh_from_db()
    assert dose.status == DoseStatus.REMINDED and dose.taken_at is None


def test_nonexistent_dose_is_404(patient_api):
    assert patient_api.post("/api/doses/999999/taken/").status_code == 404


def test_unauthenticated_rejected(client, patient):
    dose = make_dose(patient, timezone.now())
    assert client.get("/api/doses/today/").status_code == 401
    assert client.post(url(dose, "taken")).status_code == 401


@pytest.mark.parametrize("role", [Role.CAREGIVER, Role.DOCTOR])
def test_caregivers_and_doctors_can_not_act(role, patient):
    dose = make_dose(patient, timezone.now())
    api = client_for(make_user(f"{role}@example.com", role))
    assert api.get("/api/doses/today/").status_code == 403
    assert api.post(url(dose, "taken")).status_code == 403

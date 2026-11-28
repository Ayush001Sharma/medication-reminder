"""Doses react to schedule / medication / profile changes (via the API)."""
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from medications.models import Medication
from scheduling.models import DoseEvent, DoseStatus, Schedule

pytestmark = pytest.mark.django_db
IST = ZoneInfo("Asia/Kolkata")


def local_today():
    return datetime.now(IST).date()


@pytest.fixture
def med(patient):
    return Medication.objects.create(patient=patient, name="A", dosage="1",
                                     start_date=local_today() - timedelta(days=30))


def create_schedule(api, med, times=("08:00", "20:00"), **extra):
    data = {"times_of_day": list(times), "start_date": (local_today() + timedelta(days=1)).isoformat()}
    data.update(extra)
    resp = api.post(f"/api/medications/{med.id}/schedules/", data, format="json")
    assert resp.status_code == 201, resp.json()
    return Schedule.objects.get(pk=resp.json()["id"])


def local_times(qs):
    return {e.scheduled_at.astimezone(IST).time() for e in qs}


def pending(schedule):
    return DoseEvent.objects.filter(schedule=schedule, status=DoseStatus.PENDING)


def add_past_event(schedule, status=DoseStatus.PENDING):
    return DoseEvent.objects.create(
        schedule=schedule, patient=schedule.medication.patient, medication=schedule.medication,
        scheduled_at=timezone.now() - timedelta(days=1), status=status)


def test_creating_a_schedule_generates_doses_immediately(patient_api, med):
    s = create_schedule(patient_api, med)
    # tomorrow .. today+7 (local) = 7 days x 2 times
    assert pending(s).count() == 14
    assert local_times(pending(s)) == {time(8), time(20)}
    assert all(e.scheduled_at > timezone.now() for e in pending(s))


def test_editing_a_schedule_replaces_only_future_pending(patient_api, med):
    s = create_schedule(patient_api, med)
    future = list(pending(s))
    taken, missed, skipped, reminded = future[0], future[1], future[2], future[3]
    for event, status in [(taken, DoseStatus.TAKEN), (missed, DoseStatus.MISSED),
                          (skipped, DoseStatus.SKIPPED), (reminded, DoseStatus.REMINDED)]:
        event.status = status
        event.save()
    past = add_past_event(s)

    resp = patient_api.patch(f"/api/medications/{med.id}/schedules/{s.id}/",
                             {"times_of_day": ["09:00"]}, format="json")
    assert resp.status_code == 200

    future_pending = pending(s).filter(scheduled_at__gt=timezone.now())
    assert local_times(future_pending) == {time(9)}
    assert future_pending.count() == 7
    for event in (taken, missed, skipped, reminded, past):
        assert DoseEvent.objects.filter(pk=event.pk).exists(), event.status


def test_editing_keeps_unchanged_doses_without_churn(patient_api, med):
    s = create_schedule(patient_api, med)
    ids_at_8 = set(pending(s).filter(scheduled_at__in=[
        e.scheduled_at for e in pending(s) if e.scheduled_at.astimezone(IST).time() == time(8)
    ]).values_list("pk", flat=True))
    patient_api.patch(f"/api/medications/{med.id}/schedules/{s.id}/",
                      {"times_of_day": ["08:00"]}, format="json")
    assert set(pending(s).values_list("pk", flat=True)) == ids_at_8


def test_narrowing_days_of_week_removes_dropped_days(patient_api, med):
    s = create_schedule(patient_api, med, times=("08:00",))
    keep_day = (local_today() + timedelta(days=1)).weekday()
    patient_api.patch(f"/api/medications/{med.id}/schedules/{s.id}/",
                      {"days_of_week": [keep_day]}, format="json")
    assert {e.scheduled_at.astimezone(IST).weekday() for e in pending(s)} == {keep_day}


def test_deactivating_a_schedule_removes_future_pending(patient_api, med):
    s = create_schedule(patient_api, med)
    past = add_past_event(s)
    patient_api.patch(f"/api/medications/{med.id}/schedules/{s.id}/", {"is_active": False}, format="json")
    assert list(pending(s)) == [past]
    patient_api.patch(f"/api/medications/{med.id}/schedules/{s.id}/", {"is_active": True}, format="json")
    assert pending(s).count() == 15


def test_deleting_a_schedule_keeps_history(patient_api, med, patient):
    s = create_schedule(patient_api, med)
    taken = pending(s).first()
    taken.status = DoseStatus.TAKEN
    taken.save()
    past = add_past_event(s, DoseStatus.MISSED)
    past_pending = add_past_event(s)
    schedule_id = s.id

    assert patient_api.delete(f"/api/medications/{med.id}/schedules/{s.id}/").status_code == 204

    remaining = DoseEvent.objects.all()
    assert set(remaining.values_list("pk", flat=True)) == {taken.pk, past.pk, past_pending.pk}
    for event in remaining:
        assert event.schedule_id is None
        assert event.medication == med and event.patient == patient
    assert not Schedule.objects.filter(pk=schedule_id).exists()


def test_deactivating_medication_deletes_only_future_pending(patient_api, med):
    s = create_schedule(patient_api, med)
    taken = pending(s).last()
    taken.status = DoseStatus.TAKEN
    taken.save()
    past = add_past_event(s)

    assert patient_api.post(f"/api/medications/{med.id}/deactivate/").status_code == 200

    assert set(DoseEvent.objects.values_list("pk", flat=True)) == {taken.pk, past.pk}


def test_shortening_medication_end_date_drops_later_doses(patient_api, med):
    s = create_schedule(patient_api, med, times=("08:00",))
    end = local_today() + timedelta(days=3)
    patient_api.patch(f"/api/medications/{med.id}/", {"end_date": end.isoformat()}, format="json")
    assert max(e.scheduled_at.astimezone(IST).date() for e in pending(s)) == end


def test_changing_patient_timezone_moves_future_doses(patient_api, med):
    s = create_schedule(patient_api, med, times=("08:00",))
    resp = patient_api.patch("/api/me/", {"patient_profile": {"timezone": "America/New_York"}},
                             format="json")
    assert resp.status_code == 200
    ny = ZoneInfo("America/New_York")
    assert {e.scheduled_at.astimezone(ny).time() for e in pending(s)} == {time(8)}


def test_medication_with_history_cannot_be_hard_deleted(patient_api, med):
    from django.db.models import RestrictedError
    create_schedule(patient_api, med)
    with pytest.raises(RestrictedError):
        med.delete()


def test_deleting_patient_account_still_cascades(patient_api, med, patient):
    create_schedule(patient_api, med)
    patient.delete()
    assert not DoseEvent.objects.exists() and not Medication.objects.exists()

from datetime import date, time, timedelta

import pytest

from medications.models import Medication
from scheduling.models import Schedule

pytestmark = pytest.mark.django_db


@pytest.fixture
def med(patient):
    return Medication.objects.create(patient=patient, name="A", dosage="1", start_date=date(2030, 1, 1))


def url(med, pk=None):
    base = f"/api/medications/{med.id}/schedules/"
    return base + (f"{pk}/" if pk else "")


def body(**over):
    data = {"times_of_day": ["20:00", "08:00"], "start_date": "2030-01-01"}
    data.update(over)
    return data


def test_create_schedule_defaults_every_day_and_sorts_times(patient_api, med):
    resp = patient_api.post(url(med), body(), format="json")
    assert resp.status_code == 201
    assert resp.json()["times_of_day"] == ["08:00", "20:00"]
    assert resp.json()["days_of_week"] == [0, 1, 2, 3, 4, 5, 6]
    assert Schedule.objects.get().times_of_day == [time(8), time(20)]


def test_create_with_specific_days(patient_api, med):
    resp = patient_api.post(url(med), body(days_of_week=[4, 0]), format="json")
    assert resp.status_code == 201 and resp.json()["days_of_week"] == [0, 4]


def test_list_update_delete(patient_api, med):
    created = patient_api.post(url(med), body(), format="json").json()
    assert len(patient_api.get(url(med)).json()) == 1
    resp = patient_api.patch(url(med, created["id"]), {"times_of_day": ["09:30"]}, format="json")
    assert resp.status_code == 200 and resp.json()["times_of_day"] == ["09:30"]
    assert patient_api.delete(url(med, created["id"])).status_code == 204
    assert not Schedule.objects.exists()


# --- validation -----------------------------------------------------------
def test_empty_times_rejected(patient_api, med):
    assert patient_api.post(url(med), body(times_of_day=[]), format="json").status_code == 400


def test_missing_times_rejected(patient_api, med):
    assert patient_api.post(url(med), {"start_date": "2030-01-01"}, format="json").status_code == 400


def test_duplicate_times_rejected(patient_api, med):
    resp = patient_api.post(url(med), body(times_of_day=["08:00", "08:00"]), format="json")
    assert resp.status_code == 400 and "times_of_day" in resp.json()


@pytest.mark.parametrize("bad", ["25:00", "8am", "08:60", ""])
def test_malformed_time_rejected(patient_api, med, bad):
    assert patient_api.post(url(med), body(times_of_day=[bad]), format="json").status_code == 400


@pytest.mark.parametrize("days", [[], [7], [-1], [1, 1]])
def test_invalid_days_rejected(patient_api, med, days):
    assert patient_api.post(url(med), body(days_of_week=days), format="json").status_code == 400


def test_past_end_date_rejected(patient_api, med):
    past = (date.today() - timedelta(days=2)).isoformat()
    resp = patient_api.post(url(med), body(start_date="2020-01-01", end_date=past), format="json")
    assert resp.status_code == 400 and "end_date" in resp.json()


def test_end_before_start_rejected(patient_api, med):
    resp = patient_api.post(url(med), body(start_date="2030-02-01", end_date="2030-01-01"), format="json")
    assert resp.status_code == 400


# --- isolation ------------------------------------------------------------
def test_other_patient_cannot_read_or_create_schedules(patient_api, other_api, med):
    created = patient_api.post(url(med), body(), format="json").json()
    assert other_api.get(url(med)).status_code in (403, 404)
    assert other_api.post(url(med), body(), format="json").status_code in (403, 404)
    assert other_api.patch(url(med, created["id"]), {"times_of_day": ["10:00"]}, format="json").status_code in (403, 404)
    assert other_api.delete(url(med, created["id"])).status_code in (403, 404)
    assert Schedule.objects.count() == 1


def test_schedule_not_reachable_through_wrong_medication(patient_api, patient, med):
    other_med = Medication.objects.create(patient=patient, name="B", dosage="1", start_date=date(2030, 1, 1))
    created = patient_api.post(url(med), body(), format="json").json()
    assert patient_api.get(url(other_med, created["id"])).status_code == 404


def test_unauthenticated_rejected(client, med):
    assert client.get(url(med)).status_code == 401

from datetime import date, timedelta

import pytest

from accounts.models import Role
from conftest import client_for, make_user
from medications.models import Medication

pytestmark = pytest.mark.django_db
URL = "/api/medications/"


def payload(**over):
    data = {"name": "Metformin", "dosage": "500 mg", "instructions": "With food",
            "start_date": "2030-01-01"}
    data.update(over)
    return data


def test_create_and_list_own_medications(patient_api, patient):
    resp = patient_api.post(URL, payload(), format="json")
    assert resp.status_code == 201
    assert Medication.objects.get().patient == patient
    listing = patient_api.get(URL).json()
    assert [m["name"] for m in listing] == ["Metformin"]


def test_cannot_set_patient_or_is_active_on_create(patient_api, other_patient):
    resp = patient_api.post(URL, payload(patient=other_patient.id, is_active=False), format="json")
    assert resp.status_code == 201
    med = Medication.objects.get()
    assert med.patient != other_patient and med.is_active is True


def test_update_medication(patient_api, patient):
    med = Medication.objects.create(patient=patient, name="A", dosage="1", start_date=date(2030, 1, 1))
    resp = patient_api.patch(f"{URL}{med.id}/", {"dosage": "2 tablets"}, format="json")
    assert resp.status_code == 200
    med.refresh_from_db()
    assert med.dosage == "2 tablets"


def test_deactivate_keeps_record_and_filters(patient_api, patient):
    med = Medication.objects.create(patient=patient, name="A", dosage="1", start_date=date(2030, 1, 1))
    resp = patient_api.post(f"{URL}{med.id}/deactivate/")
    assert resp.status_code == 200 and resp.json()["is_active"] is False
    med.refresh_from_db()
    assert med.is_active is False
    assert patient_api.get(URL + "?active=true").json() == []
    assert len(patient_api.get(URL + "?active=false").json()) == 1


def test_delete_not_allowed(patient_api, patient):
    med = Medication.objects.create(patient=patient, name="A", dosage="1", start_date=date(2030, 1, 1))
    assert patient_api.delete(f"{URL}{med.id}/").status_code == 405


# --- validation -----------------------------------------------------------
def test_past_end_date_rejected(patient_api):
    yesterday = (date.today() - timedelta(days=2)).isoformat()
    resp = patient_api.post(URL, payload(start_date="2020-01-01", end_date=yesterday), format="json")
    assert resp.status_code == 400 and "end_date" in resp.json()


def test_end_before_start_rejected(patient_api):
    resp = patient_api.post(URL, payload(start_date="2030-02-01", end_date="2030-01-01"), format="json")
    assert resp.status_code == 400


def test_name_and_dosage_required(patient_api):
    resp = patient_api.post(URL, {"start_date": "2030-01-01"}, format="json")
    assert resp.status_code == 400 and {"name", "dosage"} <= set(resp.json())


def test_expired_medication_can_still_be_edited(patient_api, patient):
    med = Medication.objects.create(patient=patient, name="Old", dosage="1",
                                    start_date=date(2020, 1, 1), end_date=date(2020, 2, 1))
    resp = patient_api.patch(f"{URL}{med.id}/", {"instructions": "note"}, format="json")
    assert resp.status_code == 200


# --- isolation / permissions ----------------------------------------------
def test_patient_cannot_see_other_patients_medications(patient, other_api):
    med = Medication.objects.create(patient=patient, name="Secret", dosage="1", start_date=date(2030, 1, 1))
    assert other_api.get(URL).json() == []
    assert other_api.get(f"{URL}{med.id}/").status_code in (403, 404)


def test_patient_cannot_modify_or_deactivate_others(patient, other_api):
    med = Medication.objects.create(patient=patient, name="Secret", dosage="1", start_date=date(2030, 1, 1))
    assert other_api.patch(f"{URL}{med.id}/", {"name": "x"}, format="json").status_code in (403, 404)
    assert other_api.post(f"{URL}{med.id}/deactivate/").status_code in (403, 404)
    med.refresh_from_db()
    assert med.name == "Secret" and med.is_active


def test_unauthenticated_rejected(client):
    assert client.get(URL).status_code == 401


@pytest.mark.parametrize("role", [Role.CAREGIVER, Role.DOCTOR])
def test_non_patients_forbidden(role, db):
    api = client_for(make_user(f"{role}@example.com", role))
    assert api.get(URL).status_code == 403
    assert api.post(URL, payload(), format="json").status_code == 403

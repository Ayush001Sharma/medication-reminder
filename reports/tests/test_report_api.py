from datetime import UTC, date, datetime, timedelta

import pytest
from django.utils import timezone

from accounts.models import AccessGrant, Role
from conftest import client_for, make_dose, make_grant, make_user
from reports.models import AuditAction, AuditLog
from scheduling.models import DoseStatus as S

pytestmark = pytest.mark.django_db
URL = "/api/reports/adherence/"


@pytest.fixture
def seeded(patient):
    now = timezone.now()
    make_dose(patient, now - timedelta(hours=5), S.TAKEN)
    make_dose(patient, now - timedelta(hours=4), S.MISSED)
    make_dose(patient, now - timedelta(hours=3), S.SKIPPED)
    return patient


# --- shape --------------------------------------------------------------------------
def test_patient_reads_own_report(seeded, patient_api):
    body = patient_api.get(URL).json()
    assert body["totals"]["taken"] == 1 and body["totals"]["adherence_percent"] == 50.0
    assert set(body) == {"patient", "range", "generated_at", "definition", "totals", "medications", "current_streak"}
    assert set(body["range"]) == {"from", "to", "timezone", "start_utc", "end_utc"}
    assert body["range"]["timezone"] == "Asia/Kolkata" and body["patient"]["timezone"] == "Asia/Kolkata"
    assert "taken / (taken + missed)" in body["definition"]
    assert body["medications"][0]["name"] == "Metformin"


def test_default_range_is_the_last_30_local_days(patient_api):
    r = patient_api.get(URL).json()["range"]
    assert (date.fromisoformat(r["to"]) - date.fromisoformat(r["from"])).days == 29


# --- range validation (patient's local dates, max 366 days) ----------------------------
def test_366_days_is_allowed_and_367_is_rejected(patient_api):
    assert patient_api.get(URL + "?from=2029-01-01&to=2029-12-31").status_code == 200  # 365
    assert patient_api.get(URL + "?from=2028-01-01&to=2028-12-31").status_code == 200  # 366 (leap)
    resp = patient_api.get(URL + "?from=2029-01-01&to=2030-01-02")  # 367
    assert resp.status_code == 400 and "366" in str(resp.json())


@pytest.mark.parametrize("query", [
    "?from=2030-06-10&to=2030-06-01",  # reversed
    "?from=10-06-2030", "?from=yesterday", "?to=2030-13-01", "?from=2030-6-1x",
])
def test_bad_ranges_rejected(patient_api, query):
    assert patient_api.get(URL + query).status_code == 400


def test_future_end_date_is_allowed_but_future_doses_are_not_counted(patient, patient_api):
    make_dose(patient, timezone.now() + timedelta(days=1), S.TAKEN)
    tomorrow = (timezone.now() + timedelta(days=2)).date().isoformat()
    body = patient_api.get(f"{URL}?to={tomorrow}").json()
    assert body["totals"]["total"] == 0


# --- who can read ----------------------------------------------------------------------
def test_grantee_with_active_grant_can_read(seeded, caregiver):
    make_grant(seeded, caregiver)
    resp = client_for(caregiver).get(f"{URL}?patient={seeded.id}")
    assert resp.status_code == 200 and resp.json()["totals"]["taken"] == 1


def test_doctor_with_active_grant_can_read(seeded, doctor):
    make_grant(seeded, doctor)
    assert client_for(doctor).get(f"{URL}?patient={seeded.id}").status_code == 200


@pytest.mark.parametrize("status", ["pending", "revoked"])
def test_grants_that_are_not_active_are_denied(seeded, caregiver, status):
    make_grant(seeded, caregiver, status)
    assert client_for(caregiver).get(f"{URL}?patient={seeded.id}").status_code == 404


def test_grantee_with_no_grant_gets_the_same_answer_as_for_a_missing_patient(seeded, caregiver):
    api = client_for(caregiver)
    nobody, missing = api.get(f"{URL}?patient={seeded.id}"), api.get(f"{URL}?patient=999999")
    assert (nobody.status_code, nobody.json()) == (missing.status_code, missing.json()) == (404, nobody.json())


def test_revoking_takes_effect_on_the_very_next_request_with_the_same_token(seeded, patient_api, caregiver):
    grant = make_grant(seeded, caregiver)
    grantee_api = client_for(caregiver)
    assert grantee_api.get(f"{URL}?patient={seeded.id}").status_code == 200
    assert patient_api.post(f"/api/access/grants/{grant.id}/revoke/").status_code == 200
    assert grantee_api.get(f"{URL}?patient={seeded.id}").status_code == 404
    # ...and inviting again restores nothing until accepted:
    patient_api.post("/api/access/grants/", {"email": caregiver.email}, format="json")
    assert grantee_api.get(f"{URL}?patient={seeded.id}").status_code == 404


def test_grant_for_one_patient_does_not_open_another(seeded, other_patient, caregiver):
    make_grant(seeded, caregiver)
    assert client_for(caregiver).get(f"{URL}?patient={other_patient.id}").status_code == 404


def test_grantee_must_name_a_patient(caregiver):
    assert client_for(caregiver).get(URL).status_code == 400


def test_patient_cannot_read_another_patients_report(seeded, other_api):
    assert other_api.get(f"{URL}?patient={seeded.id}").status_code == 404


def test_unauthenticated_denied(client, patient):
    assert client.get(f"{URL}?patient={patient.id}").status_code == 401


def test_logged_in_grantee_whose_grant_row_was_deleted_is_denied(seeded, caregiver):
    grant = make_grant(seeded, caregiver)
    grantee_api = client_for(caregiver)
    grant.delete()
    assert grantee_api.get(f"{URL}?patient={seeded.id}").status_code == 404


# --- audit log -------------------------------------------------------------------------
def test_grantee_view_writes_an_audit_entry(seeded, caregiver):
    make_grant(seeded, caregiver)
    before = timezone.now()
    client_for(caregiver).get(f"{URL}?patient={seeded.id}&from=2030-01-01&to=2030-01-31")
    entry = AuditLog.objects.get()
    assert (entry.viewer, entry.viewer_email, entry.viewer_role) == (caregiver, caregiver.email, "caregiver")
    assert (entry.patient, entry.action) == (seeded, AuditAction.REPORT_VIEW)
    assert (entry.range_start, entry.range_end) == (date(2030, 1, 1), date(2030, 1, 31))
    assert before <= entry.created_at <= timezone.now()


def test_every_view_is_logged(seeded, caregiver, doctor):
    make_grant(seeded, caregiver)
    make_grant(seeded, doctor)
    for api in (client_for(caregiver), client_for(caregiver), client_for(doctor)):
        api.get(f"{URL}?patient={seeded.id}")
    assert AuditLog.objects.count() == 3
    assert AuditLog.objects.filter(viewer=caregiver).count() == 2


def test_denied_and_invalid_requests_are_not_logged_as_views(seeded, caregiver):
    api = client_for(caregiver)
    api.get(f"{URL}?patient={seeded.id}")  # no grant
    make_grant(seeded, caregiver)
    api.get(f"{URL}?patient={seeded.id}&from=2030-06-10&to=2030-06-01")  # invalid range
    assert AuditLog.objects.count() == 0


def test_a_patient_viewing_their_own_report_is_not_audited(seeded, patient_api):
    patient_api.get(URL)
    assert AuditLog.objects.count() == 0


def test_no_data_is_returned_if_the_audit_write_fails(seeded, caregiver, monkeypatch):
    make_grant(seeded, caregiver)
    api = client_for(caregiver)
    api.raise_request_exception = False

    def boom(*a, **k):
        raise RuntimeError("audit store down")
    monkeypatch.setattr("reports.audit.AuditLog.objects.create", boom)
    resp = api.get(f"{URL}?patient={seeded.id}")
    assert resp.status_code == 500 and b"totals" not in resp.content


def test_audit_entry_outlives_the_viewer_account(seeded, caregiver):
    make_grant(seeded, caregiver)
    client_for(caregiver).get(f"{URL}?patient={seeded.id}")
    caregiver.delete()
    entry = AuditLog.objects.get()
    assert entry.viewer is None and entry.viewer_email == "caregiver@example.com"


def test_patient_sees_their_own_audit_log_newest_first(seeded, patient_api, caregiver, doctor, other_patient):
    make_grant(seeded, caregiver)
    make_grant(seeded, doctor)
    make_grant(other_patient, doctor)
    client_for(caregiver).get(f"{URL}?patient={seeded.id}")
    client_for(doctor).get(f"{URL}?patient={seeded.id}&from=2030-02-01&to=2030-02-28")
    client_for(doctor).get(f"{URL}?patient={other_patient.id}")  # someone else's entry

    body = patient_api.get("/api/audit-log/").json()
    assert body["count"] == 2
    assert [(r["viewer_email"], r["viewer_role"]) for r in body["results"]] == [
        (doctor.email, "doctor"), (caregiver.email, "caregiver")]
    assert body["results"][0]["range_start"] == "2030-02-01"
    assert set(body["results"][0]) == {"id", "action", "viewer_email", "viewer_role", "range_start", "range_end", "created_at"}


def test_audit_log_is_paginated(seeded, patient_api, caregiver):
    make_grant(seeded, caregiver)
    api = client_for(caregiver)
    for _ in range(5):
        api.get(f"{URL}?patient={seeded.id}")
    body = patient_api.get("/api/audit-log/?limit=2").json()
    assert (body["count"], len(body["results"])) == (5, 2) and body["next"]


@pytest.mark.parametrize("role", [Role.CAREGIVER, Role.DOCTOR])
def test_only_patients_can_read_the_audit_log(role, seeded):
    assert client_for(make_user(f"{role}-a@example.com", role)).get("/api/audit-log/").status_code == 403


def test_audit_log_requires_authentication(client):
    assert client.get("/api/audit-log/").status_code == 401


def test_schema_documents_the_new_endpoints(client):
    schema = client.get("/api/schema/").content.decode()
    for path in ("/api/reports/adherence/", "/api/audit-log/", "/api/access/grants/", "/api/patients/"):
        assert path in schema

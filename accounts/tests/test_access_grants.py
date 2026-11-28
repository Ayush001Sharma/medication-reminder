import threading

import pytest
from django.db import IntegrityError, connection, transaction

from accounts.access import accessible_patients, active_grantees, has_active_grant, resolve_patient
from accounts.models import AccessGrant, GrantStatus, Role
from conftest import client_for, make_grant, make_user

pytestmark = pytest.mark.django_db
GRANTS = "/api/access/grants/"


def invite(api, email):
    return api.post(GRANTS, {"email": email}, format="json")


# --- inviting -------------------------------------------------------------------
def test_invite_creates_pending_grant(patient_api, patient):
    resp = invite(patient_api, "Nurse@Example.com")
    assert resp.status_code == 202
    grant = AccessGrant.objects.get()
    assert (grant.patient, grant.invited_email, grant.status) == (patient, "nurse@example.com", "pending")
    assert grant.grantee is None and grant.revoked_at is None


def test_invite_response_is_identical_whether_or_not_the_account_exists(
    patient_api, caregiver, doctor, other_patient
):
    """Cannot be used to discover which emails are registered."""
    responses = [
        invite(patient_api, email)
        for email in (caregiver.email, doctor.email, other_patient.email, "nobody-at-all@example.com")
    ]
    assert {r.status_code for r in responses} == {202}
    assert len({str(r.json()) for r in responses}) == 1
    assert AccessGrant.objects.count() == 4  # same work done in every case


def test_pending_grants_look_the_same_in_the_list_regardless_of_account(patient_api, caregiver):
    invite(patient_api, caregiver.email)
    invite(patient_api, "ghost@example.com")
    rows = patient_api.get(GRANTS).json()
    assert {r["status"] for r in rows} == {"pending"} and {r["grantee"] for r in rows} == {None}


def test_duplicate_invite_is_absorbed_with_the_same_response(patient_api, caregiver):
    first = invite(patient_api, caregiver.email)
    second = invite(patient_api, caregiver.email.upper())
    assert (first.status_code, first.json()) == (second.status_code, second.json())
    assert AccessGrant.objects.count() == 1


def test_invite_while_active_does_not_create_a_second_grant(patient_api, patient, caregiver):
    make_grant(patient, caregiver)
    assert invite(patient_api, caregiver.email).status_code == 202
    assert AccessGrant.objects.count() == 1


def test_revoked_grantee_can_be_invited_again(patient_api, patient, caregiver):
    old = make_grant(patient, caregiver, "revoked")
    assert invite(patient_api, caregiver.email).status_code == 202
    assert AccessGrant.objects.filter(patient=patient).count() == 2
    new = AccessGrant.objects.exclude(pk=old.pk).get()
    assert new.status == "pending" and old.status == "revoked"


def test_database_rejects_two_open_grants_for_one_pair(patient, caregiver):
    make_grant(patient, caregiver, "pending")
    with pytest.raises(IntegrityError), transaction.atomic():
        make_grant(patient, caregiver, "active")


def test_two_patients_can_invite_the_same_email(patient, other_patient, caregiver):
    make_grant(patient, caregiver)
    make_grant(other_patient, caregiver)
    assert AccessGrant.objects.count() == 2


def test_cannot_invite_yourself(patient_api, patient):
    assert invite(patient_api, patient.email).status_code == 400


def test_invalid_email_rejected(patient_api):
    assert invite(patient_api, "not-an-email").status_code == 400


@pytest.mark.parametrize("role", [Role.CAREGIVER, Role.DOCTOR])
def test_only_patients_can_invite(role):
    api = client_for(make_user(f"{role}-x@example.com", role))
    assert invite(api, "a@example.com").status_code == 403 and api.get(GRANTS).status_code == 403


def test_invite_requires_authentication(client):
    assert client.post(GRANTS, {"email": "a@example.com"}).status_code == 401


# --- accepting ------------------------------------------------------------------
def test_matching_caregiver_accepts(patient_api, patient, caregiver):
    invite(patient_api, caregiver.email)
    grant = AccessGrant.objects.get()
    api = client_for(caregiver)
    listing = api.get("/api/access/invitations/").json()
    assert [(i["id"], i["patient"]["email"]) for i in listing] == [(grant.id, patient.email)]

    assert api.post(f"/api/access/invitations/{grant.id}/accept/").status_code == 200
    grant.refresh_from_db()
    assert (grant.status, grant.grantee, grant.accepted_at is not None) == ("active", caregiver, True)
    assert api.get("/api/access/invitations/").json() == []


def test_doctor_can_accept_and_accepting_twice_is_safe(patient_api, doctor):
    invite(patient_api, doctor.email)
    grant = AccessGrant.objects.get()
    api = client_for(doctor)
    assert api.post(f"/api/access/invitations/{grant.id}/accept/").status_code == 200
    stamp = AccessGrant.objects.get().accepted_at
    assert api.post(f"/api/access/invitations/{grant.id}/accept/").status_code == 200
    assert AccessGrant.objects.get().accepted_at == stamp


def test_someone_else_cannot_accept_an_invitation(patient_api, caregiver, doctor):
    invite(patient_api, caregiver.email)
    grant = AccessGrant.objects.get()
    assert client_for(doctor).post(f"/api/access/invitations/{grant.id}/accept/").status_code == 404
    assert AccessGrant.objects.get().status == "pending"


def test_a_patient_account_cannot_accept_even_with_the_invited_email(patient_api, other_patient, other_api):
    invite(patient_api, other_patient.email)
    grant = AccessGrant.objects.get()
    assert other_api.post(f"/api/access/invitations/{grant.id}/accept/").status_code == 403
    assert AccessGrant.objects.get().status == "pending"


def test_invitation_to_an_email_registered_later_can_be_accepted(patient_api):
    invite(patient_api, "later@example.com")
    later = make_user("later@example.com", Role.CAREGIVER)
    grant = AccessGrant.objects.get()
    assert client_for(later).post(f"/api/access/invitations/{grant.id}/accept/").status_code == 200


def test_revoked_invitation_cannot_be_accepted(patient_api, patient, caregiver):
    invite(patient_api, caregiver.email)
    grant = AccessGrant.objects.get()
    patient_api.post(f"{GRANTS}{grant.id}/revoke/")
    assert client_for(caregiver).post(f"/api/access/invitations/{grant.id}/accept/").status_code == 404
    assert AccessGrant.objects.get().status == "revoked"


# --- revoking -------------------------------------------------------------------
def test_patient_revokes_active_grant_and_access_stops_immediately(patient_api, patient, caregiver):
    grant = make_grant(patient, caregiver)
    assert has_active_grant(caregiver, patient.id) and accessible_patients(caregiver).exists()
    resp = patient_api.post(f"{GRANTS}{grant.id}/revoke/")
    assert resp.status_code == 200 and resp.json()["status"] == "revoked"
    grant.refresh_from_db()
    assert grant.status == "revoked" and grant.revoked_at is not None
    assert not has_active_grant(caregiver, patient.id)
    assert not accessible_patients(caregiver).exists() and not active_grantees(patient).exists()
    assert client_for(caregiver).get("/api/patients/").json() == []


def test_revoking_twice_keeps_the_first_timestamp(patient_api, patient, caregiver):
    grant = make_grant(patient, caregiver)
    patient_api.post(f"{GRANTS}{grant.id}/revoke/")
    stamp = AccessGrant.objects.get().revoked_at
    assert patient_api.post(f"{GRANTS}{grant.id}/revoke/").status_code == 200
    assert AccessGrant.objects.get().revoked_at == stamp


def test_pending_invitation_can_be_withdrawn(patient_api, patient, caregiver):
    grant = make_grant(patient, caregiver, "pending")
    assert patient_api.post(f"{GRANTS}{grant.id}/revoke/").status_code == 200
    assert AccessGrant.objects.get().status == "revoked"


def test_cannot_revoke_another_patients_grant(other_api, patient, caregiver):
    grant = make_grant(patient, caregiver)
    assert other_api.post(f"{GRANTS}{grant.id}/revoke/").status_code == 404
    assert AccessGrant.objects.get().status == "active"


@pytest.mark.parametrize("who", ["caregiver", "doctor"])
def test_grantee_cannot_revoke_via_the_patient_endpoint(request, patient, caregiver, doctor, who):
    grant = make_grant(patient, caregiver)
    assert client_for(request.getfixturevalue(who)).post(f"{GRANTS}{grant.id}/revoke/").status_code == 403


def test_patient_sees_only_own_grants_with_grantee_after_acceptance(patient_api, patient, other_patient, caregiver, doctor):
    make_grant(patient, caregiver)
    make_grant(other_patient, doctor)
    rows = patient_api.get(GRANTS).json()
    assert [(r["invited_email"], r["status"], r["grantee"]["role"]) for r in rows] == [
        (caregiver.email, "active", "caregiver")]


# --- access lookups ---------------------------------------------------------------
def test_patient_list_for_grantee_shows_only_active_grants(patient, other_patient, caregiver):
    third = make_user("third@example.com")
    make_grant(patient, caregiver)
    make_grant(other_patient, caregiver, "pending")
    make_grant(third, caregiver, "revoked")
    rows = client_for(caregiver).get("/api/patients/").json()
    assert [(r["id"], r["timezone"]) for r in rows] == [(patient.id, "Asia/Kolkata")]
    assert client_for(patient).get("/api/patients/").status_code == 403


def test_resolve_patient_rules(patient, other_patient, caregiver):
    from rest_framework.exceptions import NotFound, ValidationError
    make_grant(patient, caregiver)
    assert resolve_patient(patient, None) == patient and resolve_patient(patient, str(patient.id)) == patient
    with pytest.raises(NotFound):
        resolve_patient(patient, other_patient.id)
    assert resolve_patient(caregiver, patient.id) == patient
    with pytest.raises(NotFound):
        resolve_patient(caregiver, other_patient.id)
    with pytest.raises(NotFound):
        resolve_patient(caregiver, 999999)
    with pytest.raises(ValidationError):
        resolve_patient(caregiver, None)
    with pytest.raises(ValidationError):
        resolve_patient(caregiver, "abc")


# --- race: simultaneous invites -----------------------------------------------------
@pytest.mark.django_db(transaction=True)
def test_simultaneous_invites_create_exactly_one_grant(patient):
    from accounts import grants
    barrier, errors = threading.Barrier(6), []

    def worker():
        try:
            barrier.wait(timeout=10)
            grants.invite(patient, "race@example.com")
        except Exception as exc:
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not errors and AccessGrant.objects.filter(patient=patient).count() == 1

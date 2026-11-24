import pytest
from django.contrib import admin
from django.urls import reverse

from accounts.access import resolve_patient
from accounts.models import AccessGrant, PatientProfile, Role, User
from conftest import client_for, make_grant, make_user

pytestmark = pytest.mark.django_db


# --- user manager ------------------------------------------------------------------------
def test_create_user_requires_an_email():
    with pytest.raises(ValueError, match="email"):
        User.objects.create_user(email="", password="x" * 12)


def test_create_user_normalises_the_email_and_defaults_to_patient():
    user = User.objects.create_user(email="MiXeD@Example.COM", password="x" * 12)
    assert user.email == "mixed@example.com" and user.role == Role.PATIENT and not user.is_staff
    assert user.check_password("x" * 12) and user.password != "x" * 12  # stored hashed


def test_create_superuser_sets_staff_and_superuser():
    admin_user = User.objects.create_superuser(email="root@example.com", password="x" * 12)
    assert admin_user.is_staff and admin_user.is_superuser and admin_user.role == Role.DOCTOR


def test_string_representations(patient, caregiver):
    grant = make_grant(patient, caregiver)
    assert str(patient) == "patient@example.com"
    assert str(patient.patient_profile) == "Profile of patient@example.com"
    assert str(grant) == f"{patient.id} -> caregiver@example.com [active]"


def test_default_notification_preferences_are_not_shared_between_profiles(patient, other_patient):
    patient.patient_profile.notification_preferences["sms"] = True
    patient.patient_profile.save()
    other_patient.patient_profile.refresh_from_db()
    assert other_patient.patient_profile.notification_preferences["sms"] is False


# --- /me/ preferences ---------------------------------------------------------------------
@pytest.mark.parametrize("bad", [["email"], "email", {"email": "yes"}, {"email": 1}, {"fax": True}])
def test_invalid_notification_preferences_are_rejected(patient_api, patient, bad):
    resp = patient_api.patch(reverse("me"), {"patient_profile": {"notification_preferences": bad}}, format="json")
    assert resp.status_code == 400
    patient.patient_profile.refresh_from_db()
    assert patient.patient_profile.notification_preferences["email"] is True


def test_patching_only_the_name_leaves_the_profile_alone(patient_api, patient):
    assert patient_api.patch(reverse("me"), {"full_name": "Asha"}, format="json").status_code == 200
    patient.refresh_from_db()
    assert patient.full_name == "Asha" and patient.patient_profile.timezone == "Asia/Kolkata"


def test_email_and_role_cannot_be_changed_through_me(patient_api, patient):
    patient_api.patch(reverse("me"), {"email": "new@example.com", "role": "doctor"}, format="json")
    patient.refresh_from_db()
    assert (patient.email, patient.role) == ("patient@example.com", Role.PATIENT)


# --- access helper edge ------------------------------------------------------------------------
def test_resolve_patient_rejects_an_unknown_role(patient):
    from rest_framework.exceptions import NotFound
    stranger = User(email="x@example.com", role="admin")
    with pytest.raises(NotFound):
        resolve_patient(stranger, patient.id)


def test_inactive_grantee_loses_access_immediately(patient, caregiver):
    make_grant(patient, caregiver)
    from accounts.access import has_active_grant
    assert has_active_grant(caregiver, patient.id)
    caregiver.is_active = False
    caregiver.save()
    assert not has_active_grant(caregiver, patient.id)


# --- admin ---------------------------------------------------------------------------------------
@pytest.fixture
def superuser_client(db):
    root = User.objects.create_superuser(email="root@example.com", password="x" * 12)
    return client_for(root), root


def test_every_registered_admin_changelist_and_add_form_loads(client, superuser_client):
    from django.test import Client, RequestFactory
    _, root = superuser_client
    browser = Client()
    browser.force_login(root)
    request = RequestFactory().get("/")
    request.user = root
    make_user("someone@example.com")
    for model, model_admin in admin.site._registry.items():
        info = (model._meta.app_label, model._meta.model_name)
        assert browser.get(reverse("admin:%s_%s_changelist" % info)).status_code == 200, model
        if model_admin.has_add_permission(request):
            assert browser.get(reverse("admin:%s_%s_add" % info)).status_code == 200, model

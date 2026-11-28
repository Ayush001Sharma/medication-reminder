import pytest
from django.urls import reverse
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate
from rest_framework.views import APIView
from rest_framework.response import Response

from accounts.models import PatientProfile, Role, User
from accounts.permissions import IsCaregiver, IsDoctor, IsPatient

pytestmark = pytest.mark.django_db
PASSWORD = "Str0ng-pass-123"


@pytest.fixture
def api():
    return APIClient()


def make_user(email, role=Role.PATIENT, tz="Asia/Kolkata"):
    user = User.objects.create_user(email=email, password=PASSWORD, role=role)
    if role == Role.PATIENT:
        PatientProfile.objects.create(user=user, timezone=tz)
    return user


def auth(api, user):
    token = api.post(reverse("login"), {"email": user.email, "password": PASSWORD}).json()["access"]
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return api


# --- registration ---------------------------------------------------------
def test_register_patient_creates_profile(api):
    resp = api.post(reverse("register"), {
        "email": "Ann@Example.com", "password": PASSWORD, "role": "patient",
        "timezone": "Asia/Kolkata", "phone_number": "+911234567890",
    })
    assert resp.status_code == 201
    user = User.objects.get(email="ann@example.com")  # email normalised to lowercase
    assert user.patient_profile.timezone == "Asia/Kolkata"
    assert "password" not in resp.json()


@pytest.mark.parametrize("role", ["caregiver", "doctor"])
def test_register_non_patient_has_no_profile(api, role):
    resp = api.post(reverse("register"), {"email": f"{role}@example.com", "password": PASSWORD, "role": role})
    assert resp.status_code == 201
    assert not PatientProfile.objects.exists()


def test_register_duplicate_email_rejected(api):
    make_user("dup@example.com")
    resp = api.post(reverse("register"), {
        "email": "DUP@example.com", "password": PASSWORD, "timezone": "UTC"})
    assert resp.status_code == 400 and "email" in resp.json()


def test_register_weak_password_rejected(api):
    resp = api.post(reverse("register"), {"email": "a@example.com", "password": "123", "timezone": "UTC"})
    assert resp.status_code == 400 and "password" in resp.json()


def test_register_patient_requires_timezone(api):
    resp = api.post(reverse("register"), {"email": "a@example.com", "password": PASSWORD})
    assert resp.status_code == 400 and "timezone" in resp.json()


# --- invalid timezone -----------------------------------------------------
@pytest.mark.parametrize("bad", ["Mars/Phobos", "IST", "../etc/passwd", "/etc/passwd", ""])
def test_register_invalid_timezone_rejected(api, bad):
    resp = api.post(reverse("register"), {"email": "tz@example.com", "password": PASSWORD, "timezone": bad})
    assert resp.status_code == 400 and "timezone" in resp.json()
    assert not User.objects.exists()


def test_me_patch_invalid_timezone_rejected(api):
    user = make_user("p@example.com")
    auth(api, user)
    resp = api.patch(reverse("me"), {"patient_profile": {"timezone": "Nope/Nowhere"}}, format="json")
    assert resp.status_code == 400
    user.patient_profile.refresh_from_db()
    assert user.patient_profile.timezone == "Asia/Kolkata"


def test_model_validator_rejects_invalid_timezone():
    from django.core.exceptions import ValidationError
    profile = PatientProfile(user=make_user("m@example.com", Role.CAREGIVER), timezone="Bad/Zone")
    with pytest.raises(ValidationError):
        profile.full_clean()


# --- login / refresh ------------------------------------------------------
def test_login_returns_access_and_refresh(api):
    user = make_user("login@example.com")
    resp = api.post(reverse("login"), {"email": user.email, "password": PASSWORD})
    assert resp.status_code == 200
    assert set(resp.json()) == {"access", "refresh"}


def test_login_wrong_password(api):
    user = make_user("login@example.com")
    resp = api.post(reverse("login"), {"email": user.email, "password": "wrong"})
    assert resp.status_code == 401


def test_refresh_token(api):
    user = make_user("r@example.com")
    refresh = api.post(reverse("login"), {"email": user.email, "password": PASSWORD}).json()["refresh"]
    resp = api.post(reverse("token-refresh"), {"refresh": refresh})
    assert resp.status_code == 200 and "access" in resp.json()


# --- /me/ -----------------------------------------------------------------
def test_me_requires_authentication(api):
    assert api.get(reverse("me")).status_code == 401


def test_me_returns_patient_profile(api):
    auth(api, make_user("me@example.com"))
    body = api.get(reverse("me")).json()
    assert body["email"] == "me@example.com" and body["role"] == "patient"
    assert body["patient_profile"]["timezone"] == "Asia/Kolkata"
    assert body["patient_profile"]["notification_preferences"]["email"] is True


def test_me_update_profile_and_role_is_read_only(api):
    user = make_user("me@example.com")
    auth(api, user)
    resp = api.patch(reverse("me"), {
        "role": "doctor", "full_name": "Ann",
        "patient_profile": {"timezone": "America/New_York", "notification_preferences": {"email": False}},
    }, format="json")
    assert resp.status_code == 200
    user.refresh_from_db()
    assert user.role == Role.PATIENT  # cannot self-promote
    assert user.patient_profile.timezone == "America/New_York"
    assert user.patient_profile.notification_preferences == {"email": False}


def test_me_rejects_unknown_notification_channel(api):
    auth(api, make_user("me@example.com"))
    resp = api.patch(reverse("me"), {"patient_profile": {"notification_preferences": {"pager": True}}}, format="json")
    assert resp.status_code == 400


def test_me_for_caregiver_has_no_profile(api):
    auth(api, make_user("c@example.com", Role.CAREGIVER))
    assert api.get(reverse("me")).json().get("patient_profile") is None


# --- permission classes ---------------------------------------------------
def _status(perm, user):
    """Call a trivial view guarded by ``perm`` and return the HTTP status."""

    class View(APIView):
        permission_classes = [perm]

        def get(self, request):
            return Response("ok")

    request = APIRequestFactory().get("/")
    if user:
        force_authenticate(request, user=user)
    return View.as_view()(request).status_code


@pytest.mark.parametrize("perm,role", [(IsPatient, Role.PATIENT), (IsCaregiver, Role.CAREGIVER), (IsDoctor, Role.DOCTOR)])
def test_role_permission_allows_only_matching_role(perm, role):
    for other in Role.values:
        user = make_user(f"{other}-{role}@example.com", other)
        assert _status(perm, user) == (200 if other == role else 403)


@pytest.mark.parametrize("perm", [IsPatient, IsCaregiver, IsDoctor])
def test_role_permission_denies_anonymous(perm):
    assert _status(perm, None) in (401, 403)


# --- docs -----------------------------------------------------------------
def test_swagger_docs_and_schema_available(api):
    assert api.get("/api/docs/").status_code == 200
    schema = api.get("/api/schema/").content.decode()
    for path in ("/api/auth/register/", "/api/auth/login/", "/api/auth/refresh/", "/api/me/"):
        assert path in schema

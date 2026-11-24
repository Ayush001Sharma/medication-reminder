from collections import Counter
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.management.commands.seed_demo import DEFAULT_DEMO_PASSWORD, DEMO_EMAILS
from accounts.models import AccessGrant, User
from medications.models import Medication
from notifications.models import NotificationLog
from reports.models import AuditLog
from scheduling.models import DoseEvent, DoseStatus, Schedule

pytestmark = pytest.mark.django_db
ASHA, BEN = "demo.asha@example.com", "demo.ben@example.com"
CARLA, DOCTOR = "demo.carla@example.com", "demo.dr.rao@example.com"


@pytest.fixture(autouse=True)
def debug_on(settings):
    settings.DEBUG = True  # pytest-django forces DEBUG off; the command requires it on


def seed(*args):
    out = StringIO()
    call_command("seed_demo", *args, stdout=out)
    return out.getvalue()


def login(email, password=DEFAULT_DEMO_PASSWORD):
    api = APIClient()
    token = api.post("/api/auth/login/", {"email": email, "password": password}, format="json").json()["access"]
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return api


def test_creates_the_expected_accounts_data_and_history():
    output = seed()
    assert set(User.objects.values_list("email", flat=True)) == set(DEMO_EMAILS)
    assert dict(User.objects.values_list("email", "role")) == {
        ASHA: "patient", BEN: "patient", CARLA: "caregiver", DOCTOR: "doctor"}
    assert Medication.objects.count() == 5 and Schedule.objects.count() == 5
    doses = DoseEvent.objects.all()
    assert doses.filter(scheduled_at__lt=timezone.now()).count() > 30
    assert set(doses.values_list("status", flat=True)) >= {"taken", "missed", "skipped", "pending"}
    assert doses.filter(taken_late=True).exists() and NotificationLog.objects.exists()
    assert AuditLog.objects.count() == 2 and AccessGrant.objects.count() == 4
    assert "Demo data created" in output and DEFAULT_DEMO_PASSWORD not in output  # the password is never printed


def test_patients_are_in_different_timezones_with_future_doses_in_their_own_time():
    seed()
    zones = dict(User.objects.filter(role="patient").values_list("email", "patient_profile__timezone"))
    assert zones == {ASHA: "Asia/Kolkata", BEN: "America/New_York"}
    assert DoseEvent.objects.filter(status=DoseStatus.PENDING, scheduled_at__gt=timezone.now()).exists()


def test_running_twice_changes_nothing():
    seed()
    before = (User.objects.count(), DoseEvent.objects.count(), AccessGrant.objects.count())
    assert "already exists" in seed()
    assert (User.objects.count(), DoseEvent.objects.count(), AccessGrant.objects.count()) == before


def test_reset_rebuilds_from_scratch():
    seed()
    asha = User.objects.get(email=ASHA)
    DoseEvent.objects.create(patient=asha, medication=asha.medications.first(),
                             scheduled_at="2031-01-01T00:00:00Z", status="pending")
    other = User.objects.create_user("unrelated@example.com", "x" * 12)
    seed("--reset")
    assert not DoseEvent.objects.filter(scheduled_at__year=2031).exists()
    assert User.objects.filter(email="unrelated@example.com").exists() and other.pk  # only demo users are touched
    assert User.objects.filter(email__in=DEMO_EMAILS).count() == 4 and AccessGrant.objects.count() == 4


def test_history_gives_the_two_patients_different_adherence_and_streaks():
    seed()
    doctor = login(DOCTOR)
    reports = {}
    for email in (ASHA, BEN):
        pid = User.objects.get(email=email).id
        reports[email] = doctor.get(f"/api/reports/adherence/?patient={pid}").json()
    asha, ben = reports[ASHA], reports[BEN]
    assert asha["totals"]["total"] > 20 and ben["totals"]["total"] > 8
    assert asha["totals"]["adherence_percent"] > ben["totals"]["adherence_percent"]
    assert asha["current_streak"] >= 6 and ben["current_streak"] == 0
    assert {m["name"] for m in asha["medications"]} == {"Metformin", "Atorvastatin", "Vitamin D"}


def test_access_model_in_the_demo_data():
    seed()
    asha_id, ben_id = (User.objects.get(email=e).id for e in (ASHA, BEN))
    carla = login(CARLA)
    assert carla.get(f"/api/reports/adherence/?patient={asha_id}").status_code == 200
    assert carla.get(f"/api/reports/adherence/?patient={ben_id}").status_code == 404  # only invited, not accepted
    invitation = carla.get("/api/access/invitations/").json()[0]
    assert invitation["patient"]["email"] == BEN
    assert carla.post(f"/api/access/invitations/{invitation['id']}/accept/").status_code == 200
    assert carla.get(f"/api/reports/adherence/?patient={ben_id}").status_code == 200
    assert login(DOCTOR).get(f"/api/reports/adherence/?patient={ben_id}").status_code == 200


def test_patient_audit_log_is_populated():
    seed()
    entries = login(ASHA).get("/api/audit-log/").json()
    assert entries["count"] == 2 and {e["viewer_role"] for e in entries["results"]} == {"doctor", "caregiver"}


def test_password_can_be_chosen_and_wrong_default_then_fails(monkeypatch):
    monkeypatch.setenv("DEMO_PASSWORD", "from-env-password-1")
    seed()
    assert APIClient().post("/api/auth/login/", {"email": ASHA, "password": "from-env-password-1"}, format="json").status_code == 200
    assert APIClient().post("/api/auth/login/", {"email": ASHA, "password": DEFAULT_DEMO_PASSWORD}, format="json").status_code == 401
    seed("--reset", "--password", "from-flag-password-2")  # the flag beats the environment
    assert APIClient().post("/api/auth/login/", {"email": ASHA, "password": "from-flag-password-2"}, format="json").status_code == 200


def test_refuses_to_run_outside_debug_unless_forced(settings):
    settings.DEBUG = False
    with pytest.raises(CommandError, match="DJANGO_DEBUG"):
        seed()
    assert not User.objects.exists()
    seed("--force")
    assert User.objects.filter(email__in=DEMO_EMAILS).count() == 4


def test_history_is_internally_consistent():
    seed()
    now = timezone.now()
    for dose in DoseEvent.objects.filter(scheduled_at__lte=now):
        if dose.status == DoseStatus.TAKEN:
            assert dose.taken_at is not None and dose.taken_at <= now
            assert dose.taken_late == (dose.missed_at is not None) and (not dose.taken_late or dose.taken_at >= dose.missed_at)
        if dose.status == DoseStatus.MISSED:
            assert dose.missed_at is not None and dose.taken_at is None
    statuses = Counter(DoseEvent.objects.filter(scheduled_at__lte=now).values_list("status", flat=True))
    assert statuses[DoseStatus.PENDING] == 0  # nothing due is left pending

"""Shared pytest fixtures."""
import pytest
from rest_framework.test import APIClient

from accounts.models import PatientProfile, Role, User

PASSWORD = "Str0ng-pass-123"


def make_user(email, role=Role.PATIENT, tz="Asia/Kolkata"):
    user = User.objects.create_user(email=email, password=PASSWORD, role=role)
    if role == Role.PATIENT:
        PatientProfile.objects.create(user=user, timezone=tz)
    return user


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def patient(db):
    return make_user("patient@example.com")


@pytest.fixture
def other_patient(db):
    return make_user("other@example.com")


@pytest.fixture
def patient_api(patient):
    return client_for(patient)


@pytest.fixture
def other_api(other_patient):
    return client_for(other_patient)


@pytest.fixture(autouse=True)
def celery_eager():
    """Run Celery tasks in-process (and in the calling thread) during tests."""
    from config.celery import app

    app.conf.task_always_eager = True
    app.conf.task_eager_propagates = True
    yield


def make_dose(patient, scheduled_at, status="pending", **extra):
    """A DoseEvent without a schedule (history-style), independent of generation."""
    from datetime import date

    from medications.models import Medication
    from scheduling.models import DoseEvent

    med = Medication.objects.filter(patient=patient).first() or Medication.objects.create(
        patient=patient, name="Metformin", dosage="500 mg", instructions="With food",
        start_date=date(2026, 1, 1),
    )
    return DoseEvent.objects.create(
        patient=patient, medication=med, scheduled_at=scheduled_at, status=status, **extra
    )


def make_grant(patient, grantee, status="active"):
    """An AccessGrant in the given state (default: already accepted)."""
    from django.utils import timezone

    from accounts.models import AccessGrant

    extra = {}
    if status != "pending":
        extra["grantee"] = grantee
        extra["accepted_at"] = timezone.now()
    if status == "revoked":
        extra["revoked_at"] = timezone.now()
    return AccessGrant.objects.create(
        patient=patient, invited_email=grantee.email.lower(), status=status, **extra
    )


@pytest.fixture
def caregiver(db):
    from accounts.models import Role
    return make_user("caregiver@example.com", Role.CAREGIVER)


@pytest.fixture
def doctor(db):
    from accounts.models import Role
    return make_user("doctor@example.com", Role.DOCTOR)

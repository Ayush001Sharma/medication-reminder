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

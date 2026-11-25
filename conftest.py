"""Shared pytest fixtures."""
import threading
from contextlib import contextmanager

import celery.app.task as _celery_task
import celery.result as _celery_result
import pytest
from celery._state import _set_task_join_will_block, task_join_will_block
from rest_framework.test import APIClient

from accounts.models import PatientProfile, Role, User

PASSWORD = "Str0ng-pass-123"

# ---------------------------------------------------------------------------------------------------------------
# Celery's "never call result.get() inside a task" guard is ONE process-wide boolean. In eager mode (used by these
# tests) every `task.delay()` raises it for the duration of the task with celery.result.denied_join_result(), which
# remembers the old value and puts it back afterwards, with no lock and no per-thread storage. When tasks are
# launched from several threads at once (the concurrency tests do exactly that on purpose) the windows overlap and
# the restores can happen in the wrong order:
#
#   thread A reads False, sets True      thread B reads True (A's value), sets True
#   thread A leaves: restores False      thread B leaves: restores True   <- stuck on True for the rest of the run
#
# Every later `EagerResult.get()` then fails with "Never call result.get() within a task!", in whichever unrelated
# test happens to run next (see tests/test_celery_join_guard.py). How often the overlap hits depends on timing, so it
# showed up on a slow CI runner and not on a quiet machine. Production is not affected: eager mode is only used in
# tests, and a real worker never launches tasks through this code path.
#
# The replacement below keeps the same behaviour (the guard is on while ANY task is running) but counts the
# overlapping holders under a lock, and only restores the original value when the last one leaves.
# ---------------------------------------------------------------------------------------------------------------
CELERY_DENIED_JOIN_RESULT = _celery_result.denied_join_result  # Celery's own version, kept for the regression test
_guard = {"holders": 0, "saved": False}
_guard_lock = threading.Lock()


@contextmanager
def thread_safe_denied_join_result():
    """Drop-in for celery.result.denied_join_result that cannot leave the flag stuck when used from many threads."""
    with _guard_lock:
        if _guard["holders"] == 0:
            _guard["saved"] = task_join_will_block()
            _set_task_join_will_block(True)
        _guard["holders"] += 1
    try:
        yield
    finally:
        with _guard_lock:
            _guard["holders"] -= 1
            if _guard["holders"] == 0:
                _set_task_join_will_block(_guard["saved"])


# `celery.app.task` imported the function by name, so both names are replaced.
_celery_result.denied_join_result = thread_safe_denied_join_result
_celery_task.denied_join_result = thread_safe_denied_join_result


@pytest.fixture(autouse=True)
def celery_join_guard_is_clean():
    """Fail the test that leaves Celery's join guard raised, instead of a random innocent test that runs later."""
    assert not task_join_will_block(), "Celery's join guard was already raised when this test started"
    yield
    if task_join_will_block():
        _set_task_join_will_block(False)  # do not cascade into every following test
        pytest.fail("this test left Celery's 'no result.get() inside a task' guard raised (see conftest.py)")


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


@pytest.fixture(autouse=True)
def isolated_cache(settings):
    """Rate-limit counters live in an in-memory cache that is emptied for every test,
    so tests never share counters and never need Redis for them."""
    from django.core.cache import cache

    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    cache.clear()
    yield
    cache.clear()

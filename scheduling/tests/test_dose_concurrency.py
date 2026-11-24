"""Real threads, real PostgreSQL row locks: simultaneous actions are serialised."""
import threading
import time
from datetime import timedelta

import pytest
from django.db import connection, transaction
from django.utils import timezone

from conftest import make_dose
from notifications import services as notification_services
from scheduling import dose_actions
from scheduling.models import DoseEvent, DoseStatus

pytestmark = pytest.mark.django_db(transaction=True)


def run_in_threads(fns):
    barrier, results, errors = threading.Barrier(len(fns)), [None] * len(fns), []

    def target(i, fn):
        try:
            barrier.wait(timeout=10)
            results[i] = fn()
        except Exception as exc:
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=target, args=(i, f)) for i, f in enumerate(fns)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors
    return results


def test_simultaneous_taken_requests_change_the_dose_exactly_once(patient):
    dose = make_dose(patient, timezone.now() - timedelta(hours=3), DoseStatus.MISSED)
    results = run_in_threads([lambda: dose_actions.mark_taken(dose.id, patient.id)] * 6)
    assert sorted(changed for _, changed in results) == [False] * 5 + [True]
    assert len({d.taken_at for d, _ in results}) == 1  # everyone saw the same taken_at
    dose.refresh_from_db()
    assert (dose.status, dose.taken_late) == (DoseStatus.TAKEN, True)


def test_taken_and_skipped_racing_leave_one_consistent_winner(patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)

    def attempt(fn):
        try:
            return fn(dose.id, patient.id)[0].status
        except dose_actions.DoseConflict:
            return "conflict"

    results = run_in_threads([lambda: attempt(dose_actions.mark_taken),
                              lambda: attempt(dose_actions.mark_skipped)])
    dose.refresh_from_db()
    assert dose.status in (DoseStatus.TAKEN, DoseStatus.SKIPPED)
    assert sorted(results) == sorted([dose.status, "conflict"])  # loser got a conflict
    assert (dose.taken_at is not None) == (dose.status == DoseStatus.TAKEN)


def test_missed_job_never_overwrites_a_dose_being_taken(patient):
    dose = make_dose(patient, timezone.now() - timedelta(hours=3), DoseStatus.REMINDED)
    locked, out = threading.Event(), {}

    def take_slowly():
        with transaction.atomic():
            DoseEvent.objects.select_for_update().get(pk=dose.pk)
            dose_actions.mark_taken(dose.id, patient.id)  # re-entrant: same transaction
            locked.set()
            time.sleep(0.5)  # the missed-dose job is blocked on our row lock meanwhile

    def mark_missed():
        locked.wait(timeout=10)
        out["missed"] = notification_services.mark_missed_doses()

    threads = [threading.Thread(target=lambda f=f: (f(), connection.close())) for f in (take_slowly, mark_missed)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    dose.refresh_from_db()
    assert dose.status == DoseStatus.TAKEN and out["missed"] == 0 and dose.missed_at is None

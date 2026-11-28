"""Concurrency proofs with REAL threads, each with its own PostgreSQL connection.

``transaction=True`` makes these transactional tests: data is really
committed, so the threads see it and really contend for row locks. Nothing
here is mocked.
"""
import threading
import time
from datetime import timedelta

import pytest
from django.db import connection, transaction
from django.utils import timezone

from conftest import make_user
from notifications import conf, services
from notifications.models import NotificationLog, NotificationStatus
from notifications.tasks import deliver_notification, dispatch_reminders
from scheduling.models import DoseEvent, DoseStatus

from .factories import create_dose

pytestmark = pytest.mark.django_db(transaction=True)


def run_concurrently(fn, workers):
    """Start ``workers`` threads together (barrier) and return their results."""
    barrier = threading.Barrier(workers)
    results, errors = [None] * workers, []

    def target(i):
        try:
            barrier.wait(timeout=10)
            results[i] = fn()
        except Exception as exc:  # surfaced in the main thread below
            errors.append(exc)
        finally:
            connection.close()  # each thread has its own DB connection

    threads = [threading.Thread(target=target, args=(i,)) for i in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors
    return results


def test_two_workers_at_once_send_exactly_one_reminder(patient, mailoutbox):
    for round_ in range(10):  # repeat to give the race many chances
        mailoutbox.clear()
        create_dose(patient, timezone.now() - timedelta(seconds=round_))
        run_concurrently(lambda: dispatch_reminders.apply().result, workers=2)
        assert len(mailoutbox) == 1, f"round {round_}: {len(mailoutbox)} emails"
    assert NotificationLog.objects.filter(status=NotificationStatus.SENT).count() == 10
    assert not DoseEvent.objects.filter(status=DoseStatus.PENDING).exists()


def test_many_workers_many_doses_each_reminded_exactly_once(mailoutbox):
    patients = [make_user(f"p{i}@example.com") for i in range(5)]
    now = timezone.now()
    for i in range(30):
        create_dose(patients[i % 5], now - timedelta(seconds=i))

    def worker():
        return sum(dispatch_reminders.apply().result for _ in range(3))

    run_concurrently(worker, workers=8)
    message_ids = [m.extra_headers["Message-ID"] for m in mailoutbox]
    assert len(message_ids) == 30 and len(set(message_ids)) == 30
    assert NotificationLog.objects.filter(status=NotificationStatus.SENT).count() == 30


def test_locked_dose_is_skipped_not_waited_for(patient, mailoutbox):
    """Worker A holds its claim transaction open; worker B must skip, not block."""
    create_dose(patient, timezone.now())
    a_claimed, b_done = threading.Event(), threading.Event()
    out = {}

    def worker_a():
        with transaction.atomic():
            out["a"] = services.claim_due_doses()
            a_claimed.set()
            out["b_finished_while_a_held_lock"] = b_done.wait(timeout=10)
        return [services.deliver(r.log_id, r.token) for r in out["a"]]

    def worker_b():
        a_claimed.wait(timeout=10)
        started = time.monotonic()
        out["b"] = services.claim_due_doses()
        out["b_seconds"] = time.monotonic() - started
        b_done.set()

    threads = [threading.Thread(target=lambda f=f: (f(), connection.close())) for f in (worker_a, worker_b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert out["b"] == [] and out["b_seconds"] < 2
    assert out["b_finished_while_a_held_lock"] is True
    assert len(out["a"]) == 1 and len(mailoutbox) == 1


def test_same_delivery_task_running_twice_at_once_sends_once(patient, mailoutbox):
    """E.g. a broker redelivery racing the original task."""
    create_dose(patient, timezone.now())
    [res] = services.claim_due_doses()
    args = (res.log_id, str(res.token))
    results = run_concurrently(lambda: deliver_notification.apply(args=args).get(), workers=4)
    assert sorted(results) == ["sent", "skipped", "skipped", "skipped"]
    assert len(mailoutbox) == 1
    assert NotificationLog.objects.get().attempts == 1


def test_concurrent_recovery_of_a_stuck_send_sends_once(patient, mailoutbox):
    create_dose(patient, timezone.now())
    [lost] = services.claim_due_doses()  # the claiming worker "crashes" here
    later = timezone.now() + conf.sending_timeout() + timedelta(seconds=1)

    def recover():
        reservations = services.reserve_retries_and_stuck(now=later)
        return [services.deliver(r.log_id, r.token, now=later) for r in reservations]

    results = run_concurrently(recover, workers=4)
    assert sorted(sum(results, [])) == ["sent"]
    assert services.deliver(lost.log_id, lost.token, now=later) == "skipped"
    assert len(mailoutbox) == 1


def test_marking_missed_never_overwrites_a_dose_taken_concurrently(patient):
    dose = create_dose(patient, timezone.now() - timedelta(hours=3), DoseStatus.REMINDED)
    locked = threading.Event()
    out = {}

    def take_dose():
        with transaction.atomic():
            DoseEvent.objects.select_for_update().filter(pk=dose.pk).update(status=DoseStatus.TAKEN)
            locked.set()
            time.sleep(0.5)  # mark_missed_doses is now blocked on this row

    def mark_missed():
        locked.wait(timeout=10)
        out["missed"] = services.mark_missed_doses()

    threads = [threading.Thread(target=lambda f=f: (f(), connection.close())) for f in (take_dose, mark_missed)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    dose.refresh_from_db()
    assert dose.status == DoseStatus.TAKEN and out["missed"] == 0

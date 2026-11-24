"""Reminder pipeline: claim, then send, then record.

DELIVERY GUARANTEE: AT-LEAST-ONCE per (dose, channel)
=====================================================

Every due dose that is still pending, within the grace period, and whose
patient has the channel switched on, gets its reminder delivered at least
once, or ends in a recorded ``failed``/``cancelled`` NotificationLog. A
reminder is sent a second time in exactly one narrow window:

    the provider (SMTP server) accepted the message, and then the worker
    died (crash, OOM kill, lost database connection) before it committed
    ``status="sent"``.

The log row is then still ``sending`` with a lease. When the lease expires
(REMINDER_SENDING_TIMEOUT_SECONDS, default 10 minutes) recovery sends it
again. We chose this over at-most-once because, for medication, a rare
duplicate reminder is far less harmful than a silently lost one. The resend
carries the same Message-ID header, so many mail systems collapse it.

Nothing else can cause a duplicate:

* Two workers / overlapping Beat runs: doses are claimed with
  ``SELECT ... FOR UPDATE SKIP LOCKED`` and flipped from ``pending`` to
  ``reminded`` in the same transaction that inserts the ``sending`` log
  row, and (dose_event, channel) is UNIQUE. A dose is claimed once.
* Task retries / duplicate task deliveries / recovery racing recovery:
  sending requires swapping a one-time ``lease_token`` with a conditional
  UPDATE. Only one caller can win the swap; every other caller, including a
  redelivered copy of the same task, sees zero rows updated and sends nothing.
* A slow-but-alive sender being "recovered": the send task is hard-killed
  after EMAIL_TIMEOUT + 30s, and settings refuse a lease shorter than twice
  that. Only a whole machine frozen for longer than the lease (e.g. a paused
  VM) could still overlap, which is the same window as above.

What is NOT guaranteed: a dose that is still pending more than
REMINDER_GRACE_MINUTES after its time (workers down for longer than that)
gets no reminder. It is too late to be useful; it is later marked missed.

Life of a reminder
------------------
1. ``claim_due_doses`` (short transaction): lock due pending doses with
   SKIP LOCKED, mark them ``reminded``, insert a log row per channel with
   status ``sending`` and a fresh lease. Commit.
2. ``deliver`` (no transaction held while sending): swap the lease token
   (the ownership check), send, then record ``sent``; or record the error
   and schedule a retry with exponential backoff; or, after
   REMINDER_MAX_ATTEMPTS, record ``failed``.
3. ``reserve_retries_and_stuck``: give a new lease to rows that are due
   for a retry, or whose lease expired because a worker died mid-send.
"""
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from scheduling.models import DoseEvent, DoseStatus

from . import conf
from .channels import default_preference, enabled_channels, get_channel, patient_channels
from .content import build_reminder
from .models import NotificationLog, NotificationStatus

logger = logging.getLogger(__name__)

PREFS = "patient__patient_profile__notification_preferences"


@dataclass(frozen=True)
class Reservation:
    """Permission to make one delivery attempt for one log row."""

    log_id: int
    token: uuid.UUID


def _wants_any_channel(channels: list[str]) -> Q:
    """SQL filter: the patient has at least one of ``channels`` switched on.

    A channel missing from the stored preferences counts as its default
    (email on, sms/whatsapp off), matching ``patient_channels``.
    """
    query = Q(pk__in=[])
    for channel in channels:
        on = Q(**{f"{PREFS}__{channel}": True})
        if default_preference(channel):
            on |= ~Q(**{f"{PREFS}__has_key": channel})
        query |= on
    return query


def claim_due_doses(*, now: datetime | None = None) -> list[Reservation]:
    """Step 1: claim due doses and create their ``sending`` log rows.

    Due means pending and scheduled in [now - grace, now + lead]. Doses
    locked by another worker are skipped, not waited for. Doses whose
    patient has every enabled channel switched off are left pending (they
    can still be marked taken, or become missed).
    """
    now = now or timezone.now()
    channels = enabled_channels()
    with transaction.atomic():
        doses = list(
            DoseEvent.objects.select_for_update(skip_locked=True, of=("self",))
            .filter(
                status=DoseStatus.PENDING,
                scheduled_at__gte=now - conf.grace(),
                scheduled_at__lte=now + conf.lead(),
                medication__is_active=True,
            )
            .filter(_wants_any_channel(channels))
            .select_related("patient__patient_profile")
            .order_by("scheduled_at")[: conf.batch_size()]
        )
        # Pure safety net: rows can only exist here if a dose was reset to
        # pending by hand. We hold the dose locks, so this read cannot race.
        existing = set(
            NotificationLog.objects.filter(dose_event__in=doses)
            .values_list("dose_event_id", "channel")
        )
        reminded, logs = [], []
        for dose in doses:
            wanted = patient_channels(dose.patient, channels)
            if not wanted:
                continue
            reminded.append(dose.pk)
            logs += [
                NotificationLog(
                    dose_event=dose, channel=channel, status=NotificationStatus.SENDING,
                    lease_token=uuid.uuid4(), lease_until=now + conf.sending_timeout(),
                    next_attempt_at=now,
                )
                for channel in wanted
                if (dose.pk, channel) not in existing
            ]
        DoseEvent.objects.filter(pk__in=reminded).update(status=DoseStatus.REMINDED)
        NotificationLog.objects.bulk_create(logs)
    return [Reservation(log.pk, log.lease_token) for log in logs]


def reserve_retries_and_stuck(*, now: datetime | None = None) -> list[Reservation]:
    """Step 3: new leases for rows due a retry, or stuck in ``sending``.

    "Stuck" means a lease that expired without the row being finished: the
    worker died mid-send, or the delivery task was never enqueued. Rotating
    the token here also makes any old, still-queued task for that row a
    no-op, so recovery cannot add a second send.
    """
    now = now or timezone.now()
    with transaction.atomic():
        logs = list(
            NotificationLog.objects.select_for_update(skip_locked=True)
            .filter(status=NotificationStatus.SENDING, next_attempt_at__lte=now)
            .filter(Q(lease_until__isnull=True) | Q(lease_until__lte=now))
            .order_by("next_attempt_at")[: conf.batch_size()]
        )
        stuck = sum(1 for log in logs if log.lease_until is not None)
        for log in logs:
            log.lease_token = uuid.uuid4()
            log.lease_until = now + conf.sending_timeout()
        NotificationLog.objects.bulk_update(logs, ["lease_token", "lease_until"])
    if stuck:
        logger.warning("Recovered %s notification(s) stuck in 'sending'", stuck)
    return [Reservation(log.pk, log.lease_token) for log in logs]


def dispatch(*, now: datetime | None = None) -> list[Reservation]:
    """One Beat tick: retries and recoveries first, then newly due doses."""
    now = now or timezone.now()
    return reserve_retries_and_stuck(now=now) + claim_due_doses(now=now)


def _acquire(log_id: int, token, now: datetime) -> uuid.UUID | None:
    """Swap the reserved token for a new one. Exactly one caller can win.

    A single conditional UPDATE: PostgreSQL row locking means a concurrent
    caller with the same token waits, re-checks the WHERE clause, and finds
    the token already changed.
    """
    new_token = uuid.uuid4()
    won = NotificationLog.objects.filter(
        pk=log_id, status=NotificationStatus.SENDING, lease_token=token, lease_until__gt=now,
    ).update(
        lease_token=new_token, lease_until=now + conf.sending_timeout(),
        attempts=F("attempts") + 1, last_attempt_at=now,
    )
    return new_token if won else None


def _finish(log_id: int, token: uuid.UUID, **fields) -> bool:
    """Record an outcome, but only while we still own the lease."""
    return bool(
        NotificationLog.objects.filter(pk=log_id, lease_token=token)
        .update(lease_token=None, lease_until=None, **fields)
    )


def _reason_not_to_send(dose: DoseEvent, now: datetime) -> str:
    if dose.status != DoseStatus.REMINDED:
        return f"Dose is {dose.status}; reminder no longer needed."
    if now > dose.scheduled_at + conf.grace():
        return "Too late: past the reminder grace period."
    return ""


def deliver(log_id: int, token, *, now: datetime | None = None) -> str:
    """Step 2: make one delivery attempt. Safe to call any number of times.

    Returns "sent", "retry", "failed", "cancelled" or "skipped" (someone else
    owns or finished this row; nothing was sent).
    """
    now = now or timezone.now()
    owned = _acquire(log_id, token, now)
    if owned is None:
        return "skipped"
    log = NotificationLog.objects.select_related(
        "dose_event__medication", "dose_event__patient__patient_profile"
    ).get(pk=log_id)

    reason = _reason_not_to_send(log.dose_event, now)
    if reason:
        _finish(log_id, owned, status=NotificationStatus.CANCELLED, error=reason)
        return "cancelled"

    try:  # No transaction or row lock is held while talking to the provider.
        get_channel(log.channel).send(build_reminder(log))
    except Exception as exc:  # noqa: BLE001 - any failure is a failed attempt
        return _record_failure(log, owned, exc, now)

    sent_at = timezone.now()
    if _finish(log_id, owned, status=NotificationStatus.SENT, sent_at=sent_at, error=""):
        DoseEvent.objects.filter(pk=log.dose_event_id, reminder_sent_at__isnull=True).update(
            reminder_sent_at=sent_at
        )
    else:
        logger.warning("Notification %s sent after its lease was taken over", log_id)
    return "sent"


def _record_failure(log: NotificationLog, owned: uuid.UUID, exc: Exception, now: datetime) -> str:
    """Schedule a retry with exponential backoff, or give up after the maximum."""
    error = f"{type(exc).__name__}: {exc}"[:1000]
    if log.attempts >= conf.max_attempts():
        _finish(log.pk, owned, status=NotificationStatus.FAILED, error=error)
        logger.error("Notification %s failed permanently after %s attempts", log.pk, log.attempts)
        return "failed"
    _finish(log.pk, owned, error=error, next_attempt_at=now + conf.retry_delay(log.attempts))
    logger.warning("Notification %s attempt %s failed; will retry", log.pk, log.attempts)
    return "retry"


def mark_missed_doses(*, now: datetime | None = None) -> int:
    """Mark doses missed when still untaken DOSE_MISSED_AFTER_MINUTES after their time.

    One UPDATE: rows changing concurrently (e.g. being marked taken) are
    re-checked by PostgreSQL after their lock is released, so a dose that
    has just been taken is never overwritten. ``missed_at`` records when.
    """
    now = now or timezone.now()
    return DoseEvent.objects.filter(
        status__in=[DoseStatus.PENDING, DoseStatus.REMINDED],
        scheduled_at__lt=now - conf.missed_after(),
    ).update(status=DoseStatus.MISSED, missed_at=now)

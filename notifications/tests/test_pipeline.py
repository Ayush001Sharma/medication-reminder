"""Reminder pipeline behaviour (single-threaded; ``now`` is injected)."""
import logging
from datetime import UTC, datetime, timedelta

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.db import IntegrityError, transaction
from django.utils import timezone

from notifications import channels, conf, services
from notifications.models import NotificationLog, NotificationStatus
from notifications.tasks import deliver_notification, dispatch_reminders, mark_missed_doses
from scheduling.models import DoseEvent, DoseStatus

from .factories import create_dose

pytestmark = pytest.mark.django_db
NOW = datetime(2030, 6, 1, 2, 30, tzinfo=UTC)  # 08:00 in Asia/Kolkata


def run_tick(now):
    """One Beat tick, delivered inline."""
    return [services.deliver(r.log_id, r.token, now=now) for r in services.dispatch(now=now)]


class FlakyChannel(channels.EmailChannel):
    """Real email channel that fails the first ``failures`` attempts."""

    def __init__(self, failures):
        self.failures = failures
        self.calls = 0

    def send(self, message):
        self.calls += 1
        if self.calls <= self.failures:
            raise ConnectionError("SMTP server unavailable")
        super().send(message)


@pytest.fixture
def flaky(monkeypatch):
    def install(failures):
        channel = FlakyChannel(failures)
        monkeypatch.setitem(channels.REGISTRY, "email", channel)
        return channel
    return install


# --- happy path ----------------------------------------------------------------
def test_due_dose_is_reminded_by_email(patient, mailoutbox):
    dose = create_dose(patient, NOW)
    assert run_tick(NOW) == ["sent"]

    assert len(mailoutbox) == 1
    mail = mailoutbox[0]
    assert mail.to == [patient.email]
    assert mail.subject == "Medication reminder: Metformin"
    assert "08:00 on Sat 01 Jun 2030 (IST)" in mail.body and "With food" in mail.body

    log = NotificationLog.objects.get()
    assert (log.channel, log.status, log.attempts) == ("email", NotificationStatus.SENT, 1)
    assert log.sent_at and log.lease_token is None
    dose.refresh_from_db()
    assert dose.status == DoseStatus.REMINDED and dose.reminder_sent_at == log.sent_at


def test_email_has_stable_message_id(patient, mailoutbox):
    create_dose(patient, NOW)
    run_tick(NOW)
    log = NotificationLog.objects.get()
    assert mailoutbox[0].extra_headers["Message-ID"] == f"<dose-reminder-{log.pk}@medreminder.local>"


def test_beat_task_path_sends_reminder(patient, mailoutbox):
    create_dose(patient, timezone.now())
    dispatch_reminders.apply()
    assert len(mailoutbox) == 1


def test_lead_window(patient):
    create_dose(patient, NOW + timedelta(seconds=59))  # inside the 60 s lead
    create_dose(patient, NOW + timedelta(minutes=2))  # not yet due
    assert len(services.claim_due_doses(now=NOW)) == 1


# --- retries of the task never duplicate ----------------------------------------
def test_running_dispatch_twice_sends_once(patient, mailoutbox):
    create_dose(patient, NOW)
    run_tick(NOW)
    assert run_tick(NOW) == []
    assert len(mailoutbox) == 1


def test_retrying_the_delivery_task_does_not_duplicate(patient, mailoutbox):
    create_dose(patient, timezone.now())
    [res] = services.claim_due_doses()
    args = (res.log_id, str(res.token))
    assert deliver_notification.apply(args=args).get() == "sent"
    assert deliver_notification.apply(args=args).get() == "skipped"  # retry / redelivery
    assert len(mailoutbox) == 1
    assert NotificationLog.objects.get().attempts == 1


def test_log_is_unique_per_dose_and_channel(patient):
    create_dose(patient, NOW)
    services.claim_due_doses(now=NOW)
    log = NotificationLog.objects.get()
    with pytest.raises(IntegrityError), transaction.atomic():
        NotificationLog.objects.create(dose_event=log.dose_event, channel="email", next_attempt_at=NOW)


# --- failures, backoff, max attempts ----------------------------------------------
def test_backoff_is_exponential():
    assert [conf.retry_delay(n).total_seconds() for n in (1, 2, 3, 4)] == [60, 120, 240, 480]


def test_failed_send_is_retried_with_backoff_then_succeeds(patient, mailoutbox, flaky):
    channel = flaky(failures=2)
    create_dose(patient, NOW)

    assert run_tick(NOW) == ["retry"]
    log = NotificationLog.objects.get()
    assert log.status == NotificationStatus.SENDING and log.attempts == 1
    assert log.error == "ConnectionError: SMTP server unavailable"
    assert log.next_attempt_at == NOW + timedelta(seconds=60) and log.lease_token is None

    assert run_tick(NOW + timedelta(seconds=30)) == []  # backoff not over yet
    assert run_tick(NOW + timedelta(seconds=60)) == ["retry"]
    log.refresh_from_db()
    assert log.next_attempt_at == NOW + timedelta(seconds=60 + 120)
    assert run_tick(NOW + timedelta(seconds=179)) == []
    assert run_tick(NOW + timedelta(seconds=180)) == ["sent"]

    log.refresh_from_db()
    assert (log.status, log.attempts, log.error) == (NotificationStatus.SENT, 3, "")
    assert channel.calls == 3 and len(mailoutbox) == 1


def test_gives_up_after_max_attempts_and_records_failure(patient, mailoutbox, flaky, settings):
    settings.REMINDER_MAX_ATTEMPTS = 3
    flaky(failures=99)
    create_dose(patient, NOW)
    outcomes = []
    for minutes in range(0, 15):
        outcomes += run_tick(NOW + timedelta(minutes=minutes))
    assert outcomes == ["retry", "retry", "failed"]
    log = NotificationLog.objects.get()
    assert (log.status, log.attempts) == (NotificationStatus.FAILED, 3)
    assert "SMTP server unavailable" in log.error
    assert run_tick(NOW + timedelta(minutes=30)) == [] and mailoutbox == []


def test_retry_after_grace_period_is_cancelled(patient, mailoutbox, flaky):
    flaky(failures=1)
    create_dose(patient, NOW)
    run_tick(NOW)
    assert run_tick(NOW + timedelta(minutes=61)) == ["cancelled"]
    assert NotificationLog.objects.get().status == NotificationStatus.CANCELLED
    assert mailoutbox == []


# --- recovery of rows stuck in "sending" ---------------------------------------
def test_stuck_sending_is_recovered_after_timeout_and_sent_once(patient, mailoutbox):
    create_dose(patient, NOW)
    [lost] = services.claim_due_doses(now=NOW)  # worker died before delivering

    assert run_tick(NOW + timedelta(minutes=5)) == []  # lease still valid
    after = NOW + conf.sending_timeout() + timedelta(seconds=1)
    assert run_tick(after) == ["sent"]
    # The lost worker's token is dead: a late redelivery cannot send again.
    assert services.deliver(lost.log_id, lost.token, now=after) == "skipped"
    assert len(mailoutbox) == 1


def test_worker_dying_mid_send_is_recovered(patient, mailoutbox):
    """The documented at-least-once window: lease taken, then the worker died."""
    create_dose(patient, NOW)
    [res] = services.claim_due_doses(now=NOW)
    assert services._acquire(res.log_id, res.token, NOW) is not None  # attempt 1 starts, crash

    after = NOW + conf.sending_timeout() + timedelta(seconds=1)
    assert run_tick(after) == ["sent"]
    log = NotificationLog.objects.get()
    assert (log.status, log.attempts) == (NotificationStatus.SENT, 2)
    assert len(mailoutbox) == 1


# --- late doses (worker was down) ----------------------------------------------
def test_late_dose_within_grace_is_still_reminded(patient, mailoutbox):
    dose = create_dose(patient, NOW - timedelta(minutes=45))
    assert run_tick(NOW) == ["sent"]
    dose.refresh_from_db()
    assert dose.status == DoseStatus.REMINDED and len(mailoutbox) == 1


def test_dose_beyond_grace_is_not_reminded_and_later_missed(patient, mailoutbox):
    dose = create_dose(patient, NOW - timedelta(minutes=61))
    assert run_tick(NOW) == []
    dose.refresh_from_db()
    assert dose.status == DoseStatus.PENDING and mailoutbox == []
    services.mark_missed_doses(now=NOW + timedelta(hours=1))
    dose.refresh_from_db()
    assert dose.status == DoseStatus.MISSED


def test_grace_period_is_configurable(patient, settings):
    settings.REMINDER_GRACE_MINUTES = 10
    create_dose(patient, NOW - timedelta(minutes=11))
    assert services.claim_due_doses(now=NOW) == []


# --- skipping ------------------------------------------------------------------
def test_patient_with_email_off_is_skipped(patient, mailoutbox):
    patient.patient_profile.notification_preferences = {"email": False, "sms": False, "whatsapp": False}
    patient.patient_profile.save()
    dose = create_dose(patient, NOW)
    assert run_tick(NOW) == []
    dose.refresh_from_db()
    assert dose.status == DoseStatus.PENDING
    assert not NotificationLog.objects.exists() and mailoutbox == []


def test_missing_email_preference_defaults_to_on(patient, mailoutbox):
    patient.patient_profile.notification_preferences = {"sms": False}
    patient.patient_profile.save()
    create_dose(patient, NOW)
    assert run_tick(NOW) == ["sent"]


def test_only_opted_in_patients_get_reminders(patient, other_patient, mailoutbox):
    other_patient.patient_profile.notification_preferences = {"email": False}
    other_patient.patient_profile.save()
    create_dose(patient, NOW)
    create_dose(other_patient, NOW)
    run_tick(NOW)
    assert [m.to for m in mailoutbox] == [[patient.email]]


def test_dose_taken_before_send_is_cancelled(patient, mailoutbox):
    dose = create_dose(patient, NOW)
    [res] = services.claim_due_doses(now=NOW)
    DoseEvent.objects.filter(pk=dose.pk).update(status=DoseStatus.TAKEN)
    assert services.deliver(res.log_id, res.token, now=NOW) == "cancelled"
    assert mailoutbox == []


def test_inactive_medication_is_not_reminded(patient):
    dose = create_dose(patient, NOW)
    dose.medication.is_active = False
    dose.medication.save()
    assert services.claim_due_doses(now=NOW) == []


# --- channels ------------------------------------------------------------------
def test_stub_channels_only_log(patient, mailoutbox, settings, caplog):
    settings.NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"]
    patient.patient_profile.notification_preferences = {"email": True, "sms": True, "whatsapp": True}
    patient.patient_profile.save()
    create_dose(patient, NOW)
    with caplog.at_level(logging.INFO, logger="notifications.channels"):
        assert sorted(run_tick(NOW)) == ["sent", "sent", "sent"]
    assert len(mailoutbox) == 1
    assert "SMS stub: would send" in caplog.text and "WhatsApp stub: would send" in caplog.text
    assert set(NotificationLog.objects.values_list("channel", flat=True)) == {"email", "sms", "whatsapp"}


def test_stub_channels_respect_default_off_preferences(patient, settings):
    settings.NOTIFICATION_CHANNELS = ["email", "sms"]
    create_dose(patient, NOW)  # default prefs: sms off
    services.claim_due_doses(now=NOW)
    assert list(NotificationLog.objects.values_list("channel", flat=True)) == ["email"]


def test_channel_interface_is_abstract():
    with pytest.raises(TypeError):
        channels.NotificationChannel()


def test_unknown_channel_setting_is_rejected(settings):
    settings.NOTIFICATION_CHANNELS = ["email", "pager"]
    with pytest.raises(ImproperlyConfigured):
        channels.enabled_channels()


# --- missed doses --------------------------------------------------------------
def test_overdue_dose_becomes_missed(patient):
    reminded_old = create_dose(patient, NOW - timedelta(minutes=121), DoseStatus.REMINDED)
    pending_old = create_dose(patient, NOW - timedelta(hours=3))
    taken_old = create_dose(patient, NOW - timedelta(hours=3), DoseStatus.TAKEN)
    skipped_old = create_dose(patient, NOW - timedelta(hours=3), DoseStatus.SKIPPED)
    recent = create_dose(patient, NOW - timedelta(minutes=119), DoseStatus.REMINDED)

    assert services.mark_missed_doses(now=NOW) == 2
    for dose, status in [(reminded_old, DoseStatus.MISSED), (pending_old, DoseStatus.MISSED),
                         (taken_old, DoseStatus.TAKEN), (skipped_old, DoseStatus.SKIPPED),
                         (recent, DoseStatus.REMINDED)]:
        dose.refresh_from_db()
        assert dose.status == status
    reminded_old.refresh_from_db()
    assert reminded_old.missed_at == NOW
    assert services.mark_missed_doses(now=NOW) == 0  # idempotent


def test_missed_window_is_configurable(patient, settings):
    settings.DOSE_MISSED_AFTER_MINUTES = 30
    dose = create_dose(patient, NOW - timedelta(minutes=31), DoseStatus.REMINDED)
    services.mark_missed_doses(now=NOW)
    dose.refresh_from_db()
    assert dose.status == DoseStatus.MISSED


def test_mark_missed_task(patient):
    create_dose(patient, timezone.now() - timedelta(hours=3))
    assert mark_missed_doses.apply().get() == 1


def test_beat_runs_both_tasks(settings):
    tasks = {e["task"]: e["schedule"] for e in settings.CELERY_BEAT_SCHEDULE.values()}
    assert "notifications.tasks.dispatch_reminders" in tasks
    assert "notifications.tasks.mark_missed_doses" in tasks

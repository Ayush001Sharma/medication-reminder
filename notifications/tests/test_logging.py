"""Structured logging of the reminder pipeline."""
import json
import logging
from datetime import UTC, datetime, timedelta

import pytest

from config.logging_utils import StructuredFormatter, log_event
from notifications import services
from notifications.tasks import dispatch_reminders
from scheduling.models import DoseStatus

from .factories import create_dose
from .test_pipeline import NOW, flaky, run_tick  # noqa: F401  (flaky is a fixture)

pytestmark = pytest.mark.django_db
SERVICES = "notifications.services"


def events(caplog):
    """Structured events from the notifications package only (not Celery's own lines)."""
    return [(r.event, r.fields) for r in caplog.records
            if hasattr(r, "event") and r.name.startswith("notifications")]


def names(caplog):
    return [name for name, _ in events(caplog)]


def test_a_successful_reminder_logs_claim_and_send(patient, caplog):
    dose = create_dose(patient, NOW - timedelta(seconds=30))
    with caplog.at_level(logging.INFO, logger=SERVICES):
        run_tick(NOW)
    assert names(caplog) == ["reminder.claimed", "reminder.sent"]
    claimed, sent = (fields for _, fields in events(caplog))
    assert claimed["dose_id"] == dose.id and claimed["channel"] == "email" and claimed["lateness_s"] == 30
    assert sent["log_id"] == claimed["log_id"] and sent["attempt"] == 1 and sent["send_ms"] >= 0
    assert sent["lateness_s"] == 30


def test_failure_logs_the_error_type_then_gives_up(patient, flaky, caplog, settings):
    settings.REMINDER_MAX_ATTEMPTS = 2
    flaky(failures=99)
    create_dose(patient, NOW)
    with caplog.at_level(logging.INFO, logger=SERVICES):
        for minutes in range(0, 6):
            run_tick(NOW + timedelta(minutes=minutes))
    retry = dict(events(caplog))["reminder.retry_scheduled"]
    failed = dict(events(caplog))["reminder.failed"]
    assert (retry["attempt"], retry["error_type"]) == (1, "ConnectionError") and "retry_at" in retry
    assert (failed["attempts"], failed["error_type"]) == (2, "ConnectionError")
    levels = {r.event: r.levelname for r in caplog.records if hasattr(r, "event")}
    assert levels["reminder.retry_scheduled"] == "WARNING" and levels["reminder.failed"] == "ERROR"


def test_recovery_of_a_stuck_send_is_a_warning(patient, caplog):
    create_dose(patient, NOW)
    services.claim_due_doses(now=NOW)
    later = NOW + timedelta(minutes=11)
    with caplog.at_level(logging.INFO, logger=SERVICES):
        services.reserve_retries_and_stuck(now=later)
    record = next(r for r in caplog.records if getattr(r, "event", "") == "reminder.recovered")
    assert record.levelname == "WARNING" and record.fields["attempts"] == 0


def test_cancelled_and_skipped_are_logged(patient, caplog):
    from scheduling.models import DoseEvent
    dose = create_dose(patient, NOW)
    [res] = services.claim_due_doses(now=NOW)
    DoseEvent.objects.filter(pk=dose.pk).update(status=DoseStatus.TAKEN)
    caplog.clear()
    with caplog.at_level(logging.INFO, logger=SERVICES):
        services.deliver(res.log_id, res.token, now=NOW)
        services.deliver(res.log_id, res.token, now=NOW)
    assert names(caplog) == ["reminder.cancelled", "reminder.skipped"]
    assert events(caplog)[0][1]["dose_status"] == "taken"


def test_missed_doses_are_counted_in_one_event(patient, caplog):
    create_dose(patient, NOW - timedelta(hours=3))
    create_dose(patient, NOW - timedelta(hours=4), DoseStatus.REMINDED)
    with caplog.at_level(logging.INFO, logger=SERVICES):
        services.mark_missed_doses(now=NOW)
        services.mark_missed_doses(now=NOW)  # nothing left: stays silent
    assert events(caplog) == [("dose.marked_missed", {"count": 2})]


def test_dispatch_task_logs_a_summary_only_when_it_did_something(patient, caplog):
    with caplog.at_level(logging.INFO, logger="notifications.tasks"):
        dispatch_reminders.apply()
        assert events(caplog) == []
        create_dose(patient, datetime.now(UTC))
        dispatch_reminders.apply()
    summary = dict(events(caplog))["reminder.dispatch"]
    assert summary["reservations"] == 1 and summary["duration_ms"] >= 0


def test_logs_never_contain_personal_data_or_error_messages(patient, flaky, caplog):
    flaky(failures=1)
    create_dose(patient, NOW)
    with caplog.at_level(logging.DEBUG):
        run_tick(NOW)
        run_tick(NOW + timedelta(minutes=2))
    formatter = StructuredFormatter("json")
    output = "\n".join(formatter.format(r) for r in caplog.records if r.name.startswith("notifications"))
    assert output
    for secret in (patient.email, "Metformin", "500 mg", "SMTP server unavailable", "dose-reminder-"):
        assert secret not in output


# --- the formatter ------------------------------------------------------------------------------------
def make_record(**fields):
    logger = logging.getLogger("demo")
    record = logger.makeRecord("demo", logging.INFO, __file__, 1, "thing.happened", (), None,
                               extra={"event": "thing.happened", "fields": fields})
    return record


def test_json_formatter_emits_one_valid_object_per_line():
    line = StructuredFormatter("json").format(make_record(dose_id=7, channel="email"))
    data = json.loads(line)
    assert "\n" not in line
    assert data["event"] == "thing.happened" and data["dose_id"] == 7 and data["level"] == "INFO"
    assert data["logger"] == "demo" and data["ts"].endswith("+00:00")


def test_plain_formatter_is_human_readable():
    line = StructuredFormatter("plain").format(make_record(dose_id=7, channel="email"))
    assert line.endswith("INFO demo thing.happened dose_id=7 channel=email")


def test_formatter_handles_ordinary_records_and_exceptions():
    logger = logging.getLogger("plain")
    try:
        raise ValueError("boom")
    except ValueError:
        import sys
        record = logger.makeRecord("plain", logging.ERROR, __file__, 1, "went wrong %s", ("badly",), sys.exc_info())
    data = json.loads(StructuredFormatter("json").format(record))
    assert data["event"] == "went wrong badly" and "ValueError: boom" in data["exception"]


def test_log_event_puts_fields_on_the_record(caplog):
    with caplog.at_level(logging.INFO):
        log_event(logging.getLogger("x"), "a.b", logging.WARNING, n=1)
    record = caplog.records[0]
    assert (record.event, record.fields, record.levelname) == ("a.b", {"n": 1}, "WARNING")


def test_project_logging_uses_the_structured_formatter(settings):
    handler = settings.LOGGING["handlers"]["console"]
    assert settings.LOGGING["formatters"][handler["formatter"]]["()"] == "config.logging_utils.StructuredFormatter"

"""Weekly adherence summary emails.

WHEN: a patient's week is Monday-Sunday in THEIR timezone. From
WEEKLY_SUMMARY_LOCAL_HOUR (default 08:00) local time on the following Monday,
the most recent completed week is sent. The job runs hourly, so each
timezone is served when its own week ends, and a worker that was down simply
catches up on its next run (within the same week).

WHO: the patient (unless they switched email off) and every caregiver or
doctor with an ACTIVE grant at send time. Patients with no resolved doses
that week get nothing.

DUPLICATES: one WeeklySummary row per (patient, week, recipient), UNIQUE.
A row is inserted BEFORE sending, so a second run (or an overlapping one)
cannot claim it again and so cannot send it again. If sending raises, the row
becomes ``failed`` and is retried on later runs (up to
WEEKLY_SUMMARY_MAX_ATTEMPTS); a retry is claimed with a conditional UPDATE, so
only one run wins it. This is therefore at-most-once per recipient and week,
with one narrow gap: if a worker dies after claiming a row but before
finishing, that row stays ``sending`` and is NOT resent. For a weekly digest
we prefer a rare lost email to a duplicate.
"""
import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.mail import EmailMessage
from django.db import IntegrityError, transaction
from django.db.models import Exists, F, OuterRef
from django.utils import timezone

from accounts.access import active_grantees, has_active_grant
from accounts.models import PatientProfile, Role, User
from scheduling.models import DoseEvent, DoseStatus

from . import audit
from .models import AuditAction, SummaryStatus, WeeklySummary
from .ranges import LocalRange, build_range
from .services import adherence_report

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Week:
    start: date  # Monday
    end: date  # Sunday


def completed_week(tz: ZoneInfo, now: datetime) -> Week | None:
    """The latest finished local Mon-Sun week, or None before the send hour on Monday."""
    local_now = now.astimezone(tz)
    this_monday = local_now.date() - timedelta(days=local_now.weekday())
    opens_at = datetime.combine(this_monday, time(settings.WEEKLY_SUMMARY_LOCAL_HOUR), tzinfo=tz)
    if local_now < opens_at:
        return None
    return Week(start=this_monday - timedelta(days=7), end=this_monday - timedelta(days=1))


def _patients_with_activity(tz_name: str, rng: LocalRange, now: datetime):
    """Patients in this timezone with at least one resolved, due dose in the week."""
    resolved = DoseEvent.objects.filter(
        patient=OuterRef("pk"), scheduled_at__gte=rng.start_utc, scheduled_at__lt=rng.end_utc,
        scheduled_at__lte=now, status__in=[DoseStatus.TAKEN, DoseStatus.MISSED, DoseStatus.SKIPPED],
    )
    return (
        User.objects.filter(role=Role.PATIENT, is_active=True, patient_profile__timezone=tz_name)
        .filter(Exists(resolved))
        .select_related("patient_profile")
    )


def _recipients(patient) -> list[User]:
    """Patient (if email is on) plus every grantee with an active grant right now."""
    prefs = patient.patient_profile.notification_preferences
    people = [patient] if prefs.get("email", True) is True else []
    return people + list(active_grantees(patient))


def _claim(patient, week: Week, recipient) -> WeeklySummary | None:
    """Win the right to send this summary, or None if someone already has it."""
    try:
        with transaction.atomic():
            return WeeklySummary.objects.create(
                patient=patient, recipient=recipient, week_start=week.start, week_end=week.end
            )
    except IntegrityError:
        key = {"patient": patient, "recipient": recipient, "week_start": week.start}
        won = WeeklySummary.objects.filter(
            **key, status=SummaryStatus.FAILED, attempts__lt=settings.WEEKLY_SUMMARY_MAX_ATTEMPTS
        ).update(status=SummaryStatus.SENDING, attempts=F("attempts") + 1)
        return WeeklySummary.objects.get(**key) if won else None


def _pct(value) -> str:
    return "n/a" if value is None else f"{value}%"


def render(report: dict, *, for_patient: bool, week: Week) -> tuple[str, str]:
    """Subject and plain-text body."""
    totals, who = report["totals"], report["patient"]
    name = who["full_name"] or f"patient {who['id']}"
    when = f"{week.start:%d %b} - {week.end:%d %b %Y}"
    subject = (
        f"Your weekly adherence summary ({when})" if for_patient
        else f"Weekly adherence summary for {name} ({when})"
    )
    lines = [
        f"Week: {when} ({who['timezone']})",
        f"Adherence: {_pct(totals['adherence_percent'])} "
        f"({totals['taken']} taken, {totals['missed']} missed)",
        f"Taken late: {totals['taken_late']}   Skipped: {totals['skipped']}",
        f"Current streak: {report['current_streak']} doses in a row",
    ]
    if report["medications"]:
        lines += ["", "By medication:"]
        lines += [
            f"- {m['name']} ({m['dosage']}): {_pct(m['adherence_percent'])}, "
            f"{m['taken']} taken, {m['missed']} missed, {m['skipped']} skipped"
            for m in report["medications"]
        ]
    lines += ["", "Adherence = taken / (taken + missed). Skipped doses are not counted."]
    return subject, "\n".join(lines)


def _send_email(message: EmailMessage) -> None:
    """The one place mail leaves the system (tests replace it to simulate failures)."""
    message.send(fail_silently=False)


def _deliver(record: WeeklySummary, patient, recipient, report: dict, week: Week) -> bool:
    """Send one claimed summary and record the outcome. Returns True if sent."""
    is_patient = recipient.pk == patient.pk
    if not is_patient and not has_active_grant(recipient, patient.pk):  # re-check: revoke wins
        WeeklySummary.objects.filter(pk=record.pk).update(status=SummaryStatus.CANCELLED)
        return False
    subject, body = render(report, for_patient=is_patient, week=week)
    domain = settings.DEFAULT_FROM_EMAIL.rpartition("@")[2] or "medreminder.local"
    message = EmailMessage(
        subject, body, settings.DEFAULT_FROM_EMAIL, [recipient.email],
        headers={"Message-ID": f"<weekly-summary-{record.pk}@{domain}>"},
    )
    try:
        _send_email(message)
    except Exception as exc:  # noqa: BLE001 - any failure leaves the row retryable
        WeeklySummary.objects.filter(pk=record.pk).update(
            status=SummaryStatus.FAILED, error=f"{type(exc).__name__}: {exc}"[:1000]
        )
        logger.warning("Weekly summary %s failed: %s", record.pk, type(exc).__name__)
        return False
    with transaction.atomic():
        WeeklySummary.objects.filter(pk=record.pk).update(
            status=SummaryStatus.SENT, sent_at=timezone.now(), error=""
        )
        if not is_patient:  # a third party was shown the patient's data
            rng = build_range(week.start, week.end, ZoneInfo(report["patient"]["timezone"]))
            audit.record_view(recipient, patient, rng, AuditAction.WEEKLY_SUMMARY)
    return True


def _send_for_patient(patient, week: Week, rng: LocalRange, now: datetime) -> int:
    report = adherence_report(patient, rng, now)
    sent = 0
    for recipient in _recipients(patient):
        record = _claim(patient, week, recipient)
        if record is not None and _deliver(record, patient, recipient, report, week):
            sent += 1
    return sent


def send_weekly_summaries(*, now: datetime | None = None) -> int:
    """Send every summary that is due. Safe to run any number of times."""
    now = now or timezone.now()
    sent = 0
    for tz_name in PatientProfile.objects.values_list("timezone", flat=True).distinct():
        tz = ZoneInfo(tz_name)
        week = completed_week(tz, now)
        if week is None:
            continue
        rng = build_range(week.start, week.end, tz)
        for patient in _patients_with_activity(tz_name, rng, now).iterator():
            sent += _send_for_patient(patient, week, rng, now)
    return sent

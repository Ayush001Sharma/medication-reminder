"""Dose event generation.

Schedules hold LOCAL wall-clock times. They are converted to UTC only here,
at generation time, using the patient's current IANA timezone.
"""
from datetime import date, datetime, time, timedelta

from django.db import transaction
from django.utils import timezone

from medications.utils import UTC, patient_timezone

from .models import DoseEvent, DoseStatus, Schedule

HORIZON_DAYS = 7  # keep this many days of future doses generated


def local_to_utc(day: date, at: time, tz) -> datetime:
    """Convert a local date + wall-clock time in ``tz`` to an aware UTC datetime.

    DST behaviour (we build the local datetime with ``fold=0``, per PEP 495):

    * Nonexistent local time (spring-forward gap, e.g. 02:30 on the day New
      York jumps 02:00 -> 03:00): the dose is shifted FORWARD by the length
      of the gap, so 02:30 becomes 03:30 local. The dose still happens that
      day, as soon after the intended time as the clock allows.
    * Ambiguous local time (fall-back overlap, e.g. 01:30 happens twice when
      New York goes 02:00 -> 01:00): the FIRST occurrence (the earlier UTC
      instant, still on daylight time) is used. Exactly one dose is created.

    If two schedule times collapse onto the same UTC instant (e.g. 02:30 and
    03:30 on a spring-forward day), the unique constraint keeps one dose.
    """
    return datetime.combine(day, at, tzinfo=tz).astimezone(UTC)


def _date_range(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def _effective_range(schedule: Schedule, from_date: date, to_date: date):
    """Clip [from_date, to_date] to the schedule's AND the medication's dates.

    All dates (including ``end_date``) are local dates in the patient's zone.
    """
    med = schedule.medication
    start = max(from_date, schedule.start_date, med.start_date)
    ends = [to_date] + [d for d in (schedule.end_date, med.end_date) if d]
    return start, min(ends)


def dose_times(schedule: Schedule, from_date: date, to_date: date) -> list[datetime]:
    """All UTC instants the schedule calls for between two local dates (inclusive).

    Pure calculation: ignores active flags and "now", writes nothing.
    """
    tz = patient_timezone(schedule.medication.patient)
    start, end = _effective_range(schedule, from_date, to_date)
    days = set(schedule.days_of_week)
    instants = {
        local_to_utc(day, at, tz)
        for day in _date_range(start, end)
        if day.weekday() in days
        for at in schedule.times_of_day
    }
    return sorted(instants)


def is_generatable(schedule: Schedule) -> bool:
    """Inactive schedules and inactive medications produce no doses."""
    return schedule.is_active and schedule.medication.is_active


def generate_dose_events(
    schedule: Schedule, from_date: date, to_date: date, *, now: datetime | None = None
) -> int:
    """Create pending DoseEvents for ``schedule`` between two local dates.

    Idempotent: existing (schedule, scheduled_at) rows are skipped, and
    ``bulk_create(ignore_conflicts=True)`` plus the unique constraint make
    concurrent runs safe too. Only instants strictly after ``now`` are
    created, so creating a schedule at 10:00 never produces an already-
    overdue 08:00 dose. Returns the number of new events.
    """
    if not is_generatable(schedule):
        return 0
    now = now or timezone.now()
    wanted = [t for t in dose_times(schedule, from_date, to_date) if t > now]
    existing = set(
        DoseEvent.objects.filter(schedule=schedule, scheduled_at__in=wanted)
        .values_list("scheduled_at", flat=True)
    )
    new = [
        DoseEvent(
            schedule=schedule,
            patient_id=schedule.medication.patient_id,
            medication_id=schedule.medication_id,
            scheduled_at=t,
        )
        for t in wanted
        if t not in existing
    ]
    DoseEvent.objects.bulk_create(new, ignore_conflicts=True)
    return len(new)


def delete_future_pending(queryset, *, now: datetime | None = None) -> int:
    """Delete only events that are both in the future and still pending.

    Taken, missed, skipped and reminded events, and anything in the past,
    are never touched.
    """
    now = now or timezone.now()
    deleted, _ = queryset.filter(status=DoseStatus.PENDING, scheduled_at__gt=now).delete()
    return deleted


def generation_window(schedule: Schedule, now: datetime) -> tuple[date, date]:
    """Local today .. local today + HORIZON_DAYS, in the patient's zone."""
    today = now.astimezone(patient_timezone(schedule.medication.patient)).date()
    return today, today + timedelta(days=HORIZON_DAYS)


@transaction.atomic
def sync_schedule_events(schedule_id: int, *, now: datetime | None = None) -> int:
    """Bring a schedule's future pending doses in line with its current definition.

    1. Lock the schedule row (SELECT ... FOR UPDATE) and re-read it, so a
       concurrent edit and the daily job cannot interleave and leave doses
       from a stale definition behind.
    2. Delete future pending doses that the schedule no longer calls for
       (all of them, if the schedule or medication is inactive).
    3. Create any missing doses in the horizon window.

    Doses that are unchanged keep their row, so nothing churns. Returns the
    number of new events.
    """
    now = now or timezone.now()
    schedule = (
        Schedule.objects.select_for_update(of=("self",))
        .select_related("medication__patient__patient_profile")
        .filter(pk=schedule_id)
        .first()
    )
    if schedule is None:
        return 0
    from_date, to_date = generation_window(schedule, now)
    keep = dose_times(schedule, from_date, to_date) if is_generatable(schedule) else []
    delete_future_pending(
        DoseEvent.objects.filter(schedule=schedule).exclude(scheduled_at__in=keep), now=now
    )
    return generate_dose_events(schedule, from_date, to_date, now=now)


def sync_all_active_schedules(*, now: datetime | None = None) -> int:
    """Run ``sync_schedule_events`` for every schedule that can still produce doses."""
    now = now or timezone.now()
    yesterday = (now - timedelta(days=1)).date()  # covers every timezone's "today"
    ids = (
        Schedule.objects.filter(is_active=True, medication__is_active=True)
        .exclude(end_date__lt=yesterday)
        .exclude(medication__end_date__lt=yesterday)
        .values_list("pk", flat=True)
    )
    return sum(sync_schedule_events(pk, now=now) for pk in ids.iterator())

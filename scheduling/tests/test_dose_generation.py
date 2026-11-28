"""Service-level tests. Fixed historic dates + an injected ``now`` keep them
deterministic (the post_save signal only fills today's window, which these
past date ranges never overlap)."""
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.conf import settings
from django.db import IntegrityError, transaction

from accounts.models import Role
from conftest import make_user
from medications.models import Medication
from scheduling.models import DoseEvent, DoseStatus, Schedule
from scheduling.services import dose_times, generate_dose_events, local_to_utc
from scheduling.tasks import generate_upcoming_doses

pytestmark = pytest.mark.django_db
NY = ZoneInfo("America/New_York")
EPOCH = datetime(2000, 1, 1, tzinfo=UTC)  # "now" far in the past: nothing is filtered


def utc(*args):
    return datetime(*args, tzinfo=UTC)


def make_schedule(tz="Asia/Kolkata", times=("08:00",), start=date(2026, 3, 1), end=None,
                  days=None, med_end=None, email="p@example.com"):
    user = make_user(email, Role.PATIENT, tz)
    med = Medication.objects.create(patient=user, name="M", dosage="1",
                                    start_date=date(2026, 1, 1), end_date=med_end)
    kwargs = {"days_of_week": days} if days is not None else {}
    return Schedule.objects.create(
        medication=med, times_of_day=[time.fromisoformat(t) for t in times],
        start_date=start, end_date=end or date(2026, 3, 31), **kwargs)


def scheduled(schedule):
    return list(DoseEvent.objects.filter(schedule=schedule).values_list("scheduled_at", flat=True))


# --- Asia/Kolkata (UTC+5:30, no DST) ------------------------------------------
def test_kolkata_local_times_convert_to_utc():
    s = make_schedule(times=("08:00", "20:00"))
    assert generate_dose_events(s, date(2026, 3, 2), date(2026, 3, 3), now=EPOCH) == 4
    assert scheduled(s) == [utc(2026, 3, 2, 2, 30), utc(2026, 3, 2, 14, 30),
                            utc(2026, 3, 3, 2, 30), utc(2026, 3, 3, 14, 30)]
    event = DoseEvent.objects.first()
    assert event.patient == s.medication.patient and event.medication == s.medication
    assert event.status == DoseStatus.PENDING


# --- America/New_York across DST -----------------------------------------------
def test_new_york_spring_forward_keeps_local_time():
    """US DST began 2026-03-08: 08:00 local is 13:00Z before, 12:00Z after."""
    s = make_schedule(tz="America/New_York")
    generate_dose_events(s, date(2026, 3, 7), date(2026, 3, 9), now=EPOCH)
    assert scheduled(s) == [utc(2026, 3, 7, 13), utc(2026, 3, 8, 12), utc(2026, 3, 9, 12)]
    assert {t.astimezone(NY).time() for t in scheduled(s)} == {time(8)}


def test_new_york_fall_back_keeps_local_time():
    """US DST ended 2026-11-01: 08:00 local is 12:00Z before, 13:00Z after."""
    s = make_schedule(tz="America/New_York", start=date(2026, 10, 31), end=date(2026, 11, 2))
    generate_dose_events(s, date(2026, 10, 31), date(2026, 11, 2), now=EPOCH)
    assert scheduled(s) == [utc(2026, 10, 31, 12), utc(2026, 11, 1, 13), utc(2026, 11, 2, 13)]


def test_nonexistent_local_time_shifts_forward_by_gap():
    """02:30 does not exist on 2026-03-08 in New York -> 03:30 EDT (07:30Z)."""
    assert local_to_utc(date(2026, 3, 8), time(2, 30), NY) == utc(2026, 3, 8, 7, 30)
    s = make_schedule(tz="America/New_York", times=("02:30",))
    generate_dose_events(s, date(2026, 3, 7), date(2026, 3, 9), now=EPOCH)
    assert scheduled(s) == [utc(2026, 3, 7, 7, 30), utc(2026, 3, 8, 7, 30), utc(2026, 3, 9, 6, 30)]


def test_ambiguous_local_time_uses_first_occurrence_once():
    """01:30 happens twice on 2026-11-01 in New York -> one dose, 01:30 EDT (05:30Z)."""
    s = make_schedule(tz="America/New_York", times=("01:30",),
                      start=date(2026, 11, 1), end=date(2026, 11, 1))
    generate_dose_events(s, date(2026, 11, 1), date(2026, 11, 1), now=EPOCH)
    assert scheduled(s) == [utc(2026, 11, 1, 5, 30)]


def test_times_colliding_in_dst_gap_create_one_dose():
    s = make_schedule(tz="America/New_York", times=("02:30", "03:30"),
                      start=date(2026, 3, 8), end=date(2026, 3, 8))
    generate_dose_events(s, date(2026, 3, 8), date(2026, 3, 8), now=EPOCH)
    assert scheduled(s) == [utc(2026, 3, 8, 7, 30)]


# --- idempotency ---------------------------------------------------------------
def test_running_generation_twice_creates_no_duplicates():
    s = make_schedule(times=("08:00", "20:00"))
    assert generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 7), now=EPOCH) == 14
    assert generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 7), now=EPOCH) == 0
    # Overlapping window only adds the new days.
    assert generate_dose_events(s, date(2026, 3, 5), date(2026, 3, 9), now=EPOCH) == 4
    assert DoseEvent.objects.count() == 18


def test_database_rejects_duplicate_dose():
    s = make_schedule()
    generate_dose_events(s, date(2026, 3, 2), date(2026, 3, 2), now=EPOCH)
    with pytest.raises(IntegrityError), transaction.atomic():
        DoseEvent.objects.create(schedule=s, patient=s.medication.patient,
                                 medication=s.medication, scheduled_at=utc(2026, 3, 2, 2, 30))


def test_bulk_insert_ignores_conflicts_from_a_concurrent_run():
    s = make_schedule()
    generate_dose_events(s, date(2026, 3, 2), date(2026, 3, 2), now=EPOCH)
    dup = DoseEvent(schedule=s, patient=s.medication.patient, medication=s.medication,
                    scheduled_at=utc(2026, 3, 2, 2, 30))
    DoseEvent.objects.bulk_create([dup], ignore_conflicts=True)
    assert DoseEvent.objects.count() == 1


# --- date rules ----------------------------------------------------------------
def test_days_of_week_respected():
    s = make_schedule(days=[0, 2])  # Mon, Wed
    generate_dose_events(s, date(2026, 3, 2), date(2026, 3, 8), now=EPOCH)  # Mon..Sun
    assert [t.date() for t in scheduled(s)] == [date(2026, 3, 2), date(2026, 3, 4)]


def test_start_and_end_dates_clip_the_window():
    s = make_schedule(start=date(2026, 3, 5), end=date(2026, 3, 6))
    generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 31), now=EPOCH)
    assert len(scheduled(s)) == 2


def test_medication_end_date_also_clips():
    s = make_schedule(med_end=date(2026, 3, 3))
    generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 10), now=EPOCH)
    assert len(scheduled(s)) == 3


def test_end_date_is_a_local_date_kolkata():
    """01:00 IST on the end date is 19:30Z the PREVIOUS UTC day; it is included."""
    s = make_schedule(times=("01:00",), start=date(2026, 3, 9), end=date(2026, 3, 10))
    generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 31), now=EPOCH)
    assert scheduled(s) == [utc(2026, 3, 8, 19, 30), utc(2026, 3, 9, 19, 30)]


def test_end_date_is_a_local_date_new_york():
    """23:00 EST on the end date is 04:00Z the NEXT UTC day; it is included."""
    s = make_schedule(tz="America/New_York", times=("23:00",),
                      start=date(2026, 3, 3), end=date(2026, 3, 3))
    generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 31), now=EPOCH)
    assert scheduled(s) == [utc(2026, 3, 4, 4)]


def test_past_instants_are_not_generated():
    s = make_schedule(times=("08:00", "20:00"))
    now = utc(2026, 3, 2, 10)  # 15:30 IST: 08:00 has passed, 20:00 has not
    generate_dose_events(s, date(2026, 3, 2), date(2026, 3, 2), now=now)
    assert scheduled(s) == [utc(2026, 3, 2, 14, 30)]


# --- active flags --------------------------------------------------------------
def test_inactive_schedule_generates_nothing():
    s = make_schedule()
    s.is_active = False
    assert generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 7), now=EPOCH) == 0


def test_inactive_medication_generates_nothing():
    s = make_schedule()
    s.medication.is_active = False
    assert generate_dose_events(s, date(2026, 3, 1), date(2026, 3, 7), now=EPOCH) == 0


def test_dose_times_is_pure():
    s = make_schedule(times=("08:00",))
    assert len(dose_times(s, date(2026, 3, 1), date(2026, 3, 3))) == 3
    assert not DoseEvent.objects.exists()


# --- daily Beat task -----------------------------------------------------------
def test_daily_task_is_scheduled_with_beat():
    entries = [e["task"] for e in settings.CELERY_BEAT_SCHEDULE.values()]
    assert "scheduling.tasks.generate_upcoming_doses" in entries


def test_daily_task_keeps_seven_days_ahead_and_is_idempotent():
    user = make_user("beat@example.com", Role.PATIENT, "Asia/Kolkata")
    med = Medication.objects.create(patient=user, name="M", dosage="1", start_date=date(2020, 1, 1))
    s = Schedule.objects.create(medication=med, times_of_day=[time(12)], start_date=date(2020, 1, 1))
    DoseEvent.objects.all().delete()  # pretend the on-save generation never ran

    generate_upcoming_doses.apply()
    times = scheduled(s)
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    local_dates = {t.astimezone(ZoneInfo("Asia/Kolkata")).date() for t in times}
    assert local_dates >= {today + timedelta(days=i) for i in range(1, 8)}
    assert max(local_dates) == today + timedelta(days=7)

    assert generate_upcoming_doses.apply().get() == 0
    assert len(scheduled(s)) == len(times)


def test_daily_task_skips_inactive_schedules_and_medications():
    user = make_user("beat@example.com", Role.PATIENT, "UTC")
    active = Medication.objects.create(patient=user, name="A", dosage="1", start_date=date(2020, 1, 1))
    stopped = Medication.objects.create(patient=user, name="B", dosage="1", start_date=date(2020, 1, 1),
                                        is_active=False)
    Schedule.objects.create(medication=active, times_of_day=[time(12)], start_date=date(2020, 1, 1),
                            is_active=False)
    Schedule.objects.create(medication=stopped, times_of_day=[time(12)], start_date=date(2020, 1, 1))
    generate_upcoming_doses.apply()
    assert not DoseEvent.objects.exists()

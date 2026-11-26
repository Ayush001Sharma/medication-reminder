# 06. Time zones and dose generation

This chapter explains the hardest idea in the project and the code that implements it. Take it slowly: it is the
topic most likely to come up in a good interview, and it is where most real systems have bugs.

## 1. First principles

### Instants, offsets and zones

* An **instant** is one precise moment in time, the same for everyone on Earth.
* **UTC** is the world's reference clock. It never has daylight saving and never jumps. We use it as the one
  true timeline: every stored moment in this project is a UTC instant.
* A **UTC offset** says how far a local clock is from UTC: Kolkata is `+05:30`, New York is `-05:00` in winter
  and `-04:00` in summer.
* A **time zone** is not an offset. It is a *set of rules* for one region that says which offset applies on
  which date. `Asia/Kolkata` and `America/New_York` are **IANA time zone names** from the tz database, which
  Python reads through the `zoneinfo` module. A name carries the history of offset changes; a bare offset does
  not.
* **Daylight saving time (DST)**: in some zones the clocks jump forward one hour in spring and back one hour in
  autumn. New York does this; Kolkata does not.

I checked the offsets with the real library:

```text
offsets: Kolkata 5:30:00 | NY on 7 Mar (winter) -5:00 | NY on 9 Mar (after the change) -4:00
```

### Wall-clock time vs instant

"08:00" is a **wall-clock time**: what a wall clock shows. It is meaningless without a date and a zone. "08:00
in New York on 8 March" and "08:00 in New York on 7 March" are different offsets from UTC. An **instant** like
`2026-03-08T12:00:00Z` is unambiguous. The skill in this chapter is converting between them correctly.

### Naive vs aware datetimes in Python

* A **naive** datetime has no time zone attached; Python cannot tell which moment it means.
* An **aware** datetime carries a `tzinfo`. Only aware datetimes identify an instant.
* `datetime.combine(day, at, tzinfo=tz)` builds an aware local datetime from a date and a wall-clock time.
* `.astimezone(UTC)` converts it to the same instant expressed in UTC.

Django is told to work with aware datetimes in UTC:

*From `config/settings.py`:*

```python
TIME_ZONE = "UTC"  # all datetimes are stored in UTC
```

(and `USE_TZ = True` a few lines below). PostgreSQL then stores `timestamp with time zone` columns such as
`DoseEvent.scheduled_at`.

### The two awkward moments: the gap and the overlap

When the clocks change, two things happen once a year in a DST zone:

* **Spring forward (the gap).** In New York on **Sunday 8 March 2026**, at 02:00 the clock jumps to 03:00. The
  local times from 02:00 to 02:59 **do not exist** that day.
* **Fall back (the overlap).** On **Sunday 1 November 2026**, at 02:00 the clock goes back to 01:00. The local
  times from 01:00 to 01:59 happen **twice**.

Python (PEP 495) handles both with an attribute called **`fold`**. By default `fold=0`. For a time in the gap,
`fold=0` means "interpret it using the offset from *before* the jump" (so 02:30 EST becomes 03:30 EDT). For a
time in the overlap, `fold=0` means "the **first** occurrence" (the earlier instant, still on daylight time).
This project uses the default `fold=0` deliberately and documents the outcome.

## 2. The building blocks

### The patient's zone and "today"

*From `medications/utils.py`:*

```python
def patient_timezone(user) -> ZoneInfo:
    """The patient's IANA zone as a ZoneInfo (UTC if the user has no profile)."""
    profile = getattr(user, "patient_profile", None)
    return ZoneInfo(profile.timezone) if profile else UTC
```

`patient_today(user)` (also in that file) returns today's date in that zone. Everything else builds on these.

### `local_to_utc`: the one conversion function

*From `scheduling/services.py`, `local_to_utc`:*

```python
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
```

The whole function is one line of code; the docstring is the specification. Every dose time in the system passes
through it. Because it is a **pure function** (no database, no clock), it is easy to test with exact answers.

### `dose_times`: all instants a schedule calls for

*From `scheduling/services.py`, `_effective_range`:*

```python
def _effective_range(schedule: Schedule, from_date: date, to_date: date):
    """Clip [from_date, to_date] to the schedule's AND the medication's dates.

    All dates (including ``end_date``) are local dates in the patient's zone.
    """
    med = schedule.medication
    start = max(from_date, schedule.start_date, med.start_date)
    ends = [to_date] + [d for d in (schedule.end_date, med.end_date) if d]
    return start, min(ends)
```

*From `scheduling/services.py`, `dose_times`:*

```python
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
```

Read it as: *for each local date in the window, if the weekday is one of the chosen days, for each wall-clock
time, convert to a UTC instant.* Two details:

* `_effective_range` clips the window to **both** the schedule's and the medication's start and end dates (a
  medication that ends earlier ends all its schedules).
* The result is a **set** comprehension, so two wall-clock times that collapse onto the same instant (the DST
  gap case) become one instant. Then it is sorted.

## 3. Generating dose rows: `generate_dose_events`

*From `scheduling/services.py`, `generate_dose_events` (body):*

```python
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
```

Step by step:

1. **Inactive schedules or medications produce nothing** (`is_generatable`).
2. **Only the future:** `if t > now`. Creating a schedule at 10:00 must not create an already-overdue 08:00 dose.
   (`now` is a parameter, which makes the function deterministic in tests.)
3. **Skip what exists:** one query loads the instants already stored for these times.
4. **Insert the rest in one statement** with `bulk_create(..., ignore_conflicts=True)`.

### Why this is idempotent (safe to run twice, or at the same time)

There are two layers of protection:

* The **existence check** (step 3) makes a normal second run create nothing.
* The **database unique constraint** `UNIQUE (schedule_id, scheduled_at)` plus `ignore_conflicts=True` makes it
  safe even if two generators run **at the same instant** and both think a dose is missing: PostgreSQL silently
  drops the duplicate instead of raising or inserting twice.

I ran it:

```text
first run created: 5 | second run created: 0
duplicate insert rejected by the database: duplicate key value violates unique constraint "unique_dose_per_schedule_time"
```

The tests are `test_running_generation_twice_creates_no_duplicates` (14 doses, then 0, then only the 4 new days
for an overlapping window), `test_database_rejects_duplicate_dose` and
`test_bulk_insert_ignores_conflicts_from_a_concurrent_run` in `scheduling/tests/test_dose_generation.py`.

## 4. Keeping doses in step with the rule: `sync_schedule_events`

Rules change (new times, new days, a paused medication). Doses must follow, **without destroying history**.

*From `scheduling/services.py`, `sync_schedule_events` (body):*

```python
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
```

The function is decorated with `@transaction.atomic`, so everything is one transaction:

1. **Lock** the schedule row (`SELECT ... FOR UPDATE`) and re-read it, so a concurrent edit and the daily job
   cannot interleave and leave doses from a stale definition. `of=("self",)` locks only the schedule row, not
   the joined medication and patient rows.
2. **Compute `keep`**: the instants the schedule *currently* calls for (empty if the schedule or medication
   is inactive).
3. **Delete** future pending doses that are no longer wanted.
4. **Generate** any missing ones.

Doses that are still correct keep their rows (nothing is deleted and re-created), so there is no churn
(`test_editing_keeps_unchanged_doses_without_churn`). The window is "local today to local today + 7 days" in the
**patient's** zone:

*From `scheduling/services.py`, `generation_window`:*

```python
def generation_window(schedule: Schedule, now: datetime) -> tuple[date, date]:
    """Local today .. local today + HORIZON_DAYS, in the patient's zone."""
    today = now.astimezone(patient_timezone(schedule.medication.patient)).date()
    return today, today + timedelta(days=HORIZON_DAYS)
```

with `HORIZON_DAYS = 7` ("keep this many days of future doses generated").

## 5. What triggers generation

| Trigger | Mechanism | File |
|---|---|---|
| A schedule is created or edited | `post_save` signal on `Schedule` | `scheduling/signals.py` |
| A medication is saved (dates changed, **deactivated**) | `post_save` signal on `Medication`; re-syncs each of its schedules | same |
| The patient's profile is saved (**timezone changed**) | `post_save` signal on `PatientProfile`; re-syncs all their schedules | same |
| A schedule is about to be deleted | `pre_delete` signal drops future pending doses | same |
| Every day at 00:10 UTC | Celery Beat runs `generate_upcoming_doses` | `scheduling/tasks.py` |

The daily job keeps the 7-day window topped up as time passes and repairs anything a signal missed (the
docstring warns that `QuerySet.update()` bypasses signals). It calls `sync_all_active_schedules`:

*From `scheduling/services.py`, `sync_all_active_schedules`:*

```python
    now = now or timezone.now()
    yesterday = (now - timedelta(days=1)).date()  # covers every timezone's "today"
    ids = (
        Schedule.objects.filter(is_active=True, medication__is_active=True)
        .exclude(end_date__lt=yesterday)
        .exclude(medication__end_date__lt=yesterday)
        .values_list("pk", flat=True)
    )
    return sum(sync_schedule_events(pk, now=now) for pk in ids.iterator())
```

The `yesterday` slack exists because "today" differs by up to a day between zones; the query keeps any schedule
that could still be running somewhere, and `sync_schedule_events` then applies the exact per-patient dates.

## 6. History is preserved

Medical history must not vanish when someone edits a rule. The rules, all in code:

*From `scheduling/services.py`, `delete_future_pending`:*

```python
def delete_future_pending(queryset, *, now: datetime | None = None) -> int:
    """Delete only events that are both in the future and still pending.

    Taken, missed, skipped and reminded events, and anything in the past,
    are never touched.
    """
    now = now or timezone.now()
    deleted, _ = queryset.filter(status=DoseStatus.PENDING, scheduled_at__gt=now).delete()
    return deleted
```

Only doses that are **both future and pending** can ever be removed. When a **schedule is deleted**, a
`pre_delete` signal removes those first, and the foreign key `DoseEvent.schedule` is `SET_NULL`, so the rest stay:

*From `scheduling/signals.py`:*

```python
@receiver(pre_delete, sender=Schedule)
def schedule_deleting(sender, instance, **kwargs):
    """Drop future pending doses BEFORE SET_NULL detaches them from the schedule."""
    delete_future_pending(DoseEvent.objects.filter(schedule=instance))
```

(It must run *before* the delete, because after `SET_NULL` the doses no longer point at the schedule, and could
not be found through it.) I built four doses by hand and deleted their schedule:

```text
past taken       -> kept, schedule_id=None
past missed      -> kept, schedule_id=None
future pending   -> deleted
future reminded  -> kept, schedule_id=None
```

Why keep a *future reminded* dose? A reminder was already sent for it; removing it would make that email lie.
Relevant tests: `test_deleting_a_schedule_keeps_history`, `test_editing_a_schedule_replaces_only_future_pending`,
`test_deactivating_medication_deletes_only_future_pending`, and `test_medication_with_history_cannot_be_hard_deleted`
in `scheduling/tests/test_dose_sync.py`.

## 7. Worked example 1: Asia/Kolkata (no daylight saving)

Kolkata is `UTC+05:30` all year, so the conversion never changes. Take a patient in `Asia/Kolkata` with a daily
schedule at `08:00` and `20:00`, and run generation for 25 to 27 November 2026 with "now" set to
`2026-11-25 06:00 UTC` (11:30 in Kolkata). I ran it:

| Local time (Kolkata) | Calculation | UTC instant stored | Created? |
|---|---|---|---|
| Wed 25 Nov 08:00 | 08:00 - 05:30 = 02:30 | `2026-11-25T02:30Z` | **No**: already before "now" (06:00Z) |
| Wed 25 Nov 20:00 | 20:00 - 05:30 = 14:30 | `2026-11-25T14:30Z` | Yes |
| Thu 26 Nov 08:00 | | `2026-11-26T02:30Z` | Yes |
| Thu 26 Nov 20:00 | | `2026-11-26T14:30Z` | Yes |
| Fri 27 Nov 08:00 | | `2026-11-27T02:30Z` | Yes |
| Fri 27 Nov 20:00 | | `2026-11-27T14:30Z` | Yes |

Result: **5 created** (the rule "only strictly after now" removed the 02:30Z dose), then **0** on the second run.
The unit test `test_kolkata_local_times_convert_to_utc` asserts exactly this kind of mapping (`08:00` becomes
`02:30Z`, `20:00` becomes `14:30Z`).

### A subtle Kolkata point: the local date and the UTC date can differ

A dose at **00:15 on 26 November in Kolkata** is `2026-11-25T18:45Z`, the **25th** in UTC. If "today's doses" were
computed with UTC midnights, this dose would appear on the wrong day. So the API builds the patient's day from
**local midnights**:

*From `scheduling/views.py`, `local_day_window`:*

```python
def local_day_window(user, now):
    """UTC bounds ``[start, end)`` of the patient's current local day.

    Built from local midnights, so a 23- or 25-hour DST day is handled.
    """
    tz = patient_timezone(user)
    today = now.astimezone(tz).date()
    return (
        local_to_utc(today, time.min, tz),
        local_to_utc(today + timedelta(days=1), time.min, tz),
    )
```

For Kolkata on 26 November that window is `2026-11-25T18:30Z` to `2026-11-26T18:30Z` (24 hours). `GET
/api/doses/today/` filters `scheduled_at >= start` and `< end` using it.

### Changing the patient's timezone

A patient who moves from Kolkata to New York keeps the **same wall-clock rule** but the instants move. I ran a
daily `08:00` schedule, then changed the zone and re-synced:

```text
Kolkata:  ['26 02:30Z', '27 02:30Z', '28 02:30Z']
New York: ['25 13:00Z', '26 13:00Z', '27 13:00Z']
```

Future pending doses are moved to the new instants (the profile signal re-syncs automatically when saved
through the API; my script used `update()` and called `sync_schedule_events` by hand). Past doses are not
touched. This is `test_changing_patient_timezone_moves_future_doses`.

## 8. Worked example 2: America/New_York across daylight saving

Daylight saving in 2026 for New York:

* **Spring forward: Sunday 8 March 2026**, 02:00 EST becomes 03:00 EDT. The offset changes from `-05:00` to
  `-04:00`.
* **Fall back: Sunday 1 November 2026**, 02:00 EDT becomes 01:00 EST. The offset changes from `-04:00` to
  `-05:00`.

All numbers below come from running `local_to_utc` and `generate_dose_events` (and match the assertions in
`scheduling/tests/test_dose_generation.py`).

### (a) Daily 08:00 across the spring-forward day

| Local date | Local time | Offset | UTC instant stored |
|---|---|---|---|
| Sat 7 Mar | 08:00 EST | -05:00 | `2026-03-07T13:00Z` |
| Sun 8 Mar | 08:00 EDT | -04:00 | `2026-03-08T12:00Z` |
| Mon 9 Mar | 08:00 EDT | -04:00 | `2026-03-09T12:00Z` |

The wall-clock time is **08:00 every day**; the UTC instant moves from 13:00 to 12:00. The doses on 7 and 8 March
are only **23 hours** apart, because the local day of 8 March is 23 hours long (I measured the local-day window:
`2026-03-08T05:00Z` to `2026-03-09T04:00Z`). Test: `test_new_york_spring_forward_keeps_local_time`.

If the system had stored `13:00Z` once, the 8 March dose would fire at 09:00 local. That is the bug this design
prevents.

### (b) A 02:30 dose on the spring-forward day (the gap)

`02:30` does **not exist** on 8 March in New York. With `fold=0` Python reads it using the pre-jump offset (EST),
then converts, which lands on 03:30 EDT:

| Local date | Wall-clock time asked | What happens | UTC instant |
|---|---|---|---|
| Sat 7 Mar | 02:30 | normal (EST) | `2026-03-07T07:30Z` |
| Sun 8 Mar | 02:30 | **does not exist**: shifted forward to **03:30 EDT** | `2026-03-08T07:30Z` |
| Mon 9 Mar | 02:30 | normal (EDT) | `2026-03-09T06:30Z` |

The dose still happens that day, as soon after the intended time as the clock allows (`local_to_utc` docstring).
Test: `test_nonexistent_local_time_shifts_forward_by_gap`.

### (c) Two times that collapse: 02:30 and 03:30 on 8 March

Both map to `2026-03-08T07:30Z`. Because `dose_times` builds a **set** of instants (and the database has the unique
constraint), exactly **one** dose is created, not two. Test: `test_times_colliding_in_dst_gap_create_one_dose`.

### (d) Daily 08:00 across the fall-back day

| Local date | Local time | Offset | UTC instant stored |
|---|---|---|---|
| Sat 31 Oct | 08:00 EDT | -04:00 | `2026-10-31T12:00Z` |
| Sun 1 Nov | 08:00 EST | -05:00 | `2026-11-01T13:00Z` |
| Mon 2 Nov | 08:00 EST | -05:00 | `2026-11-02T13:00Z` |

The local day of 1 November is **25 hours long** (`2026-11-01T04:00Z` to `2026-11-02T05:00Z`), which is why
"today" is built from local midnights and not by adding 24 hours. Test:
`test_new_york_fall_back_keeps_local_time`.

### (e) A 01:30 dose on the fall-back day (the overlap)

`01:30` happens twice on 1 November: once in EDT (`05:30Z`) and once in EST (`06:30Z`). With `fold=0` the
**first** is chosen, and only one dose is created:

```text
NY 01:30 on 2026-11-01 (twice) -> 2026-11-01T05:30:00+00:00 -> local 2026-11-01T01:30:00-04:00
```

Test: `test_ambiguous_local_time_uses_first_occurrence_once`.

### (f) Through the real generator

Daily `08:00` for 7 to 9 March, generated with "now" before the change:

```text
created: 3
   2026-03-07T13:00:00+00:00 = local Sat 07 Mar 08:00 EST
   2026-03-08T12:00:00+00:00 = local Sun 08 Mar 08:00 EDT
   2026-03-09T12:00:00+00:00 = local Mon 09 Mar 08:00 EDT
```

### The reminder email shows the right local time

The email body is rendered in the patient's zone with its abbreviation, so the patient sees "08:00 EDT", not a
UTC time:

*From `notifications/content.py`, `build_reminder`:*

```python
    local = dose.scheduled_at.astimezone(patient_timezone(patient))
    when = local.strftime("%H:%M on %a %d %b %Y") + f" ({local.tzname()})"
```

A real email I generated for a Kolkata patient said `Scheduled for 12:56 on Thu 26 Nov 2026 (IST).`

## 9. Try it yourself

In `python manage.py shell` (no database writes needed for the first block):

```python
from datetime import date, time
from zoneinfo import ZoneInfo
from scheduling.services import local_to_utc

NY = ZoneInfo("America/New_York")
for day in (date(2026, 3, 7), date(2026, 3, 8), date(2026, 3, 9)):
    print(day, local_to_utc(day, time(8), NY))
print(local_to_utc(date(2026, 3, 8), time(2, 30), NY))    # the gap
print(local_to_utc(date(2026, 11, 1), time(1, 30), NY))   # the overlap
```

Then run the tests that encode these examples:

```bash
pytest scheduling/tests/test_dose_generation.py scheduling/tests/test_dose_sync.py -v
```

I ran both files: **32 passed**. A good exercise: edit `local_to_utc` to use `at.replace(tzinfo=UTC)` instead and
watch the DST tests fail; the failures tell you exactly which behaviour each test protects.

## Interview questions on this chapter

1. **Q: Why store UTC for events but local time for schedules?**
   **A:** Events are exact moments, and UTC is the unambiguous, comparable representation. A schedule is a human
   rule ("8 am") that is only meaningful on a local clock. Converting at generation time, per date and with the
   patient's IANA zone, keeps 08:00 as 08:00 through daylight saving changes.

2. **Q: What is the difference between a time zone and a UTC offset?**
   **A:** An offset is a fixed difference such as `-05:00`. A time zone is a named rule set (`America/New_York`)
   that says which offset applies on which date, including daylight saving. Storing only the offset gives the
   wrong answer for part of the year.

3. **Q: What happens to a 02:30 dose on the day New York springs forward?**
   **A:** 02:30 does not exist that day. `local_to_utc` builds the datetime with `fold=0`, which uses the offset
   before the jump, so the instant is 07:30Z, which is 03:30 EDT. The dose is shifted forward by the length of the
   gap and still happens that day.

4. **Q: And a 01:30 dose on the fall-back day?**
   **A:** 01:30 occurs twice. With `fold=0` we take the first occurrence (EDT, 05:30Z), and only one dose is
   created. The second would be 06:30Z.

5. **Q: How is generation idempotent? What if two workers run it simultaneously?**
   **A:** There is a unique constraint on `(schedule_id, scheduled_at)`, and the insert is
   `bulk_create(ignore_conflicts=True)`. A normal rerun finds the rows already exist; a true race is resolved by
   the database dropping the duplicate. `sync_schedule_events` also locks the schedule row with
   `SELECT ... FOR UPDATE`, so concurrent syncs of one schedule are serialised.

6. **Q: How do you preserve history when a schedule changes or is deleted?**
   **A:** Only doses that are both future and pending are ever deleted (`delete_future_pending`). Taken, missed,
   skipped and reminded doses and anything in the past are kept. Deleting a schedule uses a `pre_delete` signal
   to remove future pending doses and `SET_NULL` on `DoseEvent.schedule` so the rest remain, still owned by the
   patient and medication.

7. **Q: Why does "today" use local midnights rather than adding 24 hours?**
   **A:** A DST day is 23 or 25 hours long, and a local day's boundaries are not UTC's. `local_day_window` builds
   the UTC bounds from the patient's local midnights, so a dose at 00:15 Kolkata time (18:45Z the previous UTC
   date) is shown on the correct local day.

8. **Q: What does the daily Beat job do, and why is it needed if signals already generate doses?**
   **A:** It keeps a rolling 7-day window of future doses as time passes (signals only fire when something is
   saved) and repairs anything that bypassed signals such as bulk `update()` calls. It is safe to run any
   number of times because generation is idempotent.

9. **Q: What happens when a patient changes timezone?**
   **A:** Saving the profile fires a `post_save` signal that re-syncs all the patient's schedules. Future pending
   doses move to the instants that match the same wall-clock times in the new zone; past doses are untouched.

10. **Q: Why is `local_to_utc` a pure function and why does that matter?**
    **A:** It touches no database and no clock, so it can be tested with exact inputs and outputs (Kolkata,
    spring-forward, fall-back). Keeping the tricky logic pure and the database code thin is what made the DST
    behaviour easy to verify.

## Common mistakes to avoid

* **Storing converted UTC in the schedule**, or storing a fixed offset. Both drift when the rules change.
* **Using naive datetimes.** Always attach a zone before converting (`datetime.combine(..., tzinfo=tz)`).
* **Adding 24 hours to find "tomorrow".** DST days are 23 or 25 hours. Use local midnights.
* **Using the server's clock date as "today".** Use the patient's local date.
* **Forgetting that two local times can map to one instant** (the gap), or that one local time can map to two
  (the overlap). Decide a rule, document it and test it, as this project does.
* **Comparing aware and naive datetimes.** Python raises an error; fix the cause instead of stripping zones.
* **Assuming every region has daylight saving, or that the shift is one hour.** Kolkata has none; some zones shift
  by 30 minutes. Never hard-code rules; use the IANA database.
* **Using three-letter abbreviations like `IST` for zones.** They are ambiguous (IST is also Irish and Israel
  Standard Time). This project rejects them and requires IANA names (`Asia/Kolkata`).
* **Deleting past or already-handled doses when a rule changes.** Only future pending doses may go.
* **Treating a unique-constraint error as a bug.** In generation, a conflict is the safe, expected outcome of a
  race, which is why `ignore_conflicts=True` is used.

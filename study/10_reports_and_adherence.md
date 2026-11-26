# 10. Reports and adherence

The adherence report turns thousands of dose rows into a handful of numbers a caregiver or doctor can read in
seconds. This chapter covers what the numbers *mean* (the definition), how they are computed in the database
(the aggregation queries), why the work is a **fixed number of queries** however much data there is, and how the
streak is calculated.

The code is small: `reports/services.py` (the calculation), `reports/ranges.py` (the date range),
`reports/views.py` (the endpoint, shown in chapter 09) and `reports/serializers.py` (the response shape).

## 1. First principles

### What is "adherence"?

Adherence means "how well the patient followed the plan". The simplest honest measure is: *of the doses they were
supposed to take, how many did they take?* Getting a measure like this right is mostly about deciding **which
doses count**:

* A dose scheduled for **tomorrow** has not happened; it must not count as missed.
* A dose that is **due but still open** (pending or reminded) has not been resolved yet; counting it as missed
  would punish the patient for a dose they may still take this minute.
* A dose the patient deliberately **skipped** (for example on a doctor's advice) is not the same as forgetting.

So the definition has to say clearly what is in the numerator, the denominator, and what is excluded. A number
without a definition is meaningless, which is why the API returns the definition text with every report.

### Aggregation in the database

To count rows you can (a) fetch them into Python and loop, or (b) ask the database to count (`COUNT`, `GROUP BY`)
and send back only the answer. For a year of doses (about a thousand rows) option (a) is slow and wasteful.
Option (b) is what databases are built for, and it is what this code does: **no Python loops over doses**.

## 2. The definition

Written at the top of `reports/services.py` and returned in the API as `definition`:

*From `reports/services.py`, module docstring:*

```python
DEFINITION
==========
Only doses that are DUE are counted: scheduled_at <= now. Future doses, and
due doses still ``pending`` or ``reminded`` (not resolved yet), are never
counted anywhere in the report.

    taken    = due doses with status taken (includes late ones)
    taken_late = the subset of ``taken`` that was recorded after the dose
                 had already become missed (reported separately)
    missed   = due doses with status missed
    skipped  = due doses the patient chose to skip (reported separately)
    total    = taken + missed + skipped   (resolved due doses)

    adherence % = taken / (taken + missed) * 100, rounded to 1 decimal.
    Skipped doses are NOT in the percentage. It is null when there is no
    taken or missed dose in the range.
```

In plain words:

| Number | Meaning |
|---|---|
| `taken` | Doses taken, **including** late ones |
| `taken_late` | How many of those were taken after they had already been marked missed |
| `missed` | Doses the patient never dealt with in time |
| `skipped` | Doses the patient chose to skip (reported, but not in the percentage) |
| `total` | `taken + missed + skipped`: the resolved due doses |
| `adherence_percent` | `taken / (taken + missed) x 100`, one decimal place, or `null` |

Consequences worth being able to explain:

* A **late** dose counts as taken (the patient did take it), and is *also* reported as `taken_late` so a doctor
  can see the pattern.
* **Skipped** is excluded from the percentage on purpose: skipping is a decision, not a lapse.
* The percentage is **`null`, not 0**, when there is nothing to compare (for example the patient only skipped).
  Zero would claim "took none"; `null` honestly says "no data".

*From `reports/services.py`:*

```python
def adherence_percent(taken: int, missed: int) -> float | None:
    """taken / (taken + missed) as a percentage, or None when undefined."""
    denominator = taken + missed
    return None if denominator == 0 else round(100 * taken / denominator, 1)
```

The test `test_definition_late_counts_as_taken_skipped_excluded_pending_and_future_ignored` pins the whole
definition; `test_no_taken_or_missed_gives_null_percentage` and `test_percentage_formula` cover the maths.

## 3. The date range

Reports are about a **period in the patient's own calendar**, so the range is built from local dates, exactly
like the "today" window in chapter 06.

*From `reports/ranges.py`, `build_range`:*

```python
def build_range(start_date: date, end_date: date, tz: ZoneInfo) -> LocalRange:
    """Validate and convert two inclusive local dates (max 366 days)."""
    if end_date < start_date:
        raise ValidationError({"to": "Must not be before 'from'."})
    days = (end_date - start_date).days + 1
    if days > MAX_RANGE_DAYS:
        raise ValidationError({"to": f"Range is limited to {MAX_RANGE_DAYS} days (got {days})."})
    return LocalRange(
        start_date=start_date,
        end_date=end_date,
        start_utc=local_to_utc(start_date, time.min, tz),
        end_utc=local_to_utc(end_date + timedelta(days=1), time.min, tz),
        timezone=tz.key,
    )
```

*From `reports/ranges.py`, `parse_query_range`:*

```python
def parse_query_range(params, tz: ZoneInfo, now: datetime) -> LocalRange:
    """Read ``from`` / ``to`` query parameters; default to the last 30 local days."""
    end = _parse("to", params.get("to")) or now.astimezone(tz).date()
    start = _parse("from", params.get("from")) or end - timedelta(days=DEFAULT_RANGE_DAYS - 1)
    return build_range(start, end, tz)
```

* `from` and `to` are **inclusive local dates** (`YYYY-MM-DD`). If omitted, the range is the last **30 local
  days** ending today in the patient's zone.
* The range is limited to **366 days** (one leap year), so one request cannot ask for unbounded work
  (`test_366_days_is_allowed_and_367_is_rejected`).
* The inclusive local dates become a **half-open UTC interval** `[start_utc, end_utc)` between local midnights,
  via `local_to_utc` from chapter 06. Half-open means the start is included and the end is not, so adjacent
  ranges never double count a dose that falls exactly on a boundary. A dose at 00:15 local time belongs to that
  local day even though its UTC date differs, and a 23- or 25-hour daylight saving day is handled correctly
  (`test_range_uses_the_patients_local_dates`, `test_new_york_range_across_a_dst_change`).
* The patient's timezone, not the viewer's, decides the day, even when a doctor in another country asks.

## 4. The aggregation queries

The core function:

*From `reports/services.py`, `adherence_report`:*

```python
    """The full report for one patient and local date range. Four queries, any size."""
    doses = DoseEvent.objects.filter(
        patient=patient, scheduled_at__gte=rng.start_utc, scheduled_at__lt=rng.end_utc,
        scheduled_at__lte=now, status__in=[DoseStatus.TAKEN, DoseStatus.MISSED, DoseStatus.SKIPPED],
    ).order_by()  # clear default ordering so it cannot leak into GROUP BY

    totals = doses.aggregate(**_COUNTS)
    per_medication = (
        doses.values("medication_id", "medication__name", "medication__dosage")
        .annotate(**_COUNTS)
        .order_by("medication__name", "medication_id")
    )
```

Step by step:

1. **One queryset, `doses`, expresses the definition.** For this patient, inside the range, **due** (`scheduled_at
   <= now`), and status one of taken, missed or skipped. Pending, reminded and future doses are excluded *by the
   filter*, so no later code can accidentally count them.
2. **`.order_by()` with no arguments** clears the model's default ordering. Without it, Django would add
   `ORDER BY scheduled_at, id` and, in a grouped query, that ordering can leak into the `GROUP BY` and split the
   groups. The comment says so.
3. **`doses.aggregate(**_COUNTS)`** computes the overall totals in one query.
4. **`doses.values(medication...).annotate(**_COUNTS)`** groups by medication and computes the same four counts
   per group in a second query.

The counts themselves are reusable expression objects:

*From `reports/services.py`, `_COUNTS`:*

```python
_COUNTS = {
    "taken": Count("status", filter=Q(status=DoseStatus.TAKEN)),
    "taken_late": Count("status", filter=Q(status=DoseStatus.TAKEN, taken_late=True)),
    "missed": Count("status", filter=Q(status=DoseStatus.MISSED)),
    "skipped": Count("status", filter=Q(status=DoseStatus.SKIPPED)),
}
```

`Count(..., filter=Q(...))` becomes SQL's `COUNT(x) FILTER (WHERE ...)`: **four different counts in one pass over
the rows**, instead of four queries. I captured the real SQL (shortened):

```sql
SELECT COUNT(status) FILTER (WHERE status = 'taken') AS taken,
       COUNT(status) FILTER (WHERE status = 'taken' AND taken_late) AS taken_late,
       COUNT(status) FILTER (WHERE status = 'missed') AS missed,
       COUNT(status) FILTER (WHERE status = 'skipped') AS skipped
FROM scheduling_doseevent WHERE patient_id = ... AND scheduled_at >= ... AND scheduled_at < ... AND ...
```

There is a subtle detail in the comment above `_COUNTS`: the code counts the `status` **column** and not the
primary key. `status` is `NOT NULL`, so `COUNT(status)` equals `COUNT(*)`, but `dose_patient_cover_idx`
(chapter 11) contains `status` and **not** `id`. Counting `id` would force PostgreSQL to visit the table; counting
`status` lets it answer from the index alone (an *index-only scan*).

### Deriving the rest in Python

*From `reports/services.py`, `_with_derived`:*

```python
def _with_derived(counts: dict) -> dict:
    return {
        **counts,
        "total": counts["taken"] + counts["missed"] + counts["skipped"],
        "adherence_percent": adherence_percent(counts["taken"], counts["missed"]),
    }
```

`total` and the percentage are computed from the four counts in memory (trivial arithmetic on a few numbers),
for the overall totals and for each medication.

## 5. A fixed number of queries

The docstring says it: **"Four queries, any size."** My run captured exactly four:

| # | Query | Purpose |
|---|---|---|
| 1 | `SELECT COUNT(...) FILTER ...` (aggregate) | Overall totals |
| 2 | `SELECT medication_id, name, dosage, COUNT(...) FILTER ... GROUP BY ...` | Per-medication counts (the join gets the medication's name and dosage) |
| 3 | `SELECT MAX(scheduled_at) ... status = 'missed'` | Streak: the latest missed dose |
| 4 | `SELECT COUNT(*) ... status = 'taken' AND scheduled_at > <that time>` | Streak: taken doses since then |

And then I added 300 more doses to the same patient and ran it again:

```text
queries for the report: 4
after adding 300 more doses -> queries: 4
```

The cost of one query grows with the data (and the index keeps that growth small, chapter 11), but the **number
of queries does not**. This is the opposite of the classic **N+1 problem**, where code loops over rows and runs
one extra query per row (so 1,000 doses means 1,001 queries). `test_report_uses_a_fixed_number_of_queries_regardless_of_size`
asserts that a one-day report and a thirty-day report over 300 doses use the same number of queries, at most
four.

## 6. The streak

*From `reports/services.py`, `current_streak`:*

```python
def current_streak(patient, now: datetime) -> int:
    """Taken doses since the most recent missed dose (two aggregate queries)."""
    taken = DoseEvent.objects.filter(patient=patient, status=DoseStatus.TAKEN, scheduled_at__lte=now)
    last_missed = DoseEvent.objects.filter(
        patient=patient, status=DoseStatus.MISSED, scheduled_at__lte=now
    ).aggregate(at=Max("scheduled_at"))["at"]
    if last_missed is not None:
        taken = taken.filter(scheduled_at__gt=last_missed)
    return taken.count()
```

The **streak** is the number of consecutive taken doses, most recent first, ending now. Its rules (from the module
docstring):

* A **missed** dose ends the streak.
* **Skipped**, pending and future doses are **ignored** (they neither extend nor break it).
* It is "as of now" and does **not** depend on the report's date range.

How the code gets this without looping: if the patient has never missed a dose, the streak is simply *all* taken
doses (up to now). Otherwise it is the *number of taken doses after the latest missed one*. That is two small
queries (`MAX` and `COUNT`) instead of walking doses one by one. The partial index
`dose_patient_missed_idx` (chapter 11) is what makes "the latest missed dose" instant, even for a patient who has
never missed one.

I checked it with a patient whose latest misses were 7 and 8 days ago:

```text
Metformin: 6 taken, 2 missed, 1 skipped   Aspirin: 3 taken, 0 missed, 2 skipped
streak: 9   (the 6 + 3 taken doses after the most recent missed dose; skipped ones ignored)
streak alone -> queries: 2
```

Tests: `test_streak_counts_taken_doses_since_last_missed_ignoring_skipped_and_unresolved`,
`test_streak_without_any_missed_counts_all_taken`, `test_streak_is_zero_when_latest_resolved_dose_is_missed` and
`test_streak_ignores_the_report_range_and_other_patients`.

## 7. A worked example

Using the data I created (one patient in `Asia/Kolkata`, now = 26 Nov 2026 12:00 UTC, range 28 Oct to 26 Nov),
including a pending dose and a future dose that must be ignored:

```text
totals: taken 9, taken_late 1, missed 2, skipped 3, total 14, adherence_percent 81.8
Aspirin   {'taken': 3, 'taken_late': 0, 'missed': 0, 'skipped': 2, 'total': 5, 'adherence_percent': 100.0}
Metformin {'taken': 6, 'taken_late': 1, 'missed': 2, 'skipped': 1, 'total': 9, 'adherence_percent': 75.0}
```

Work the percentage by hand: taken is 3 + 6 = 9, missed is 0 + 2 = 2, so 9 / (9 + 2) = 0.818, which is **81.8%**.
The 3 skipped doses and the pending and future doses are left out. Metformin alone is 6 / (6 + 2) = **75.0%**.
Aspirin has no missed doses, so 3 / 3 = **100.0%** even though it has 2 skips.

## 8. The response and who calls it

*From `reports/serializers.py`:*

```python
class AdherenceReportSerializer(serializers.Serializer):
    patient = ReportPatientSerializer()
    range = ReportRangeSerializer()
    generated_at = serializers.DateTimeField()
    definition = serializers.CharField()
    totals = CountsSerializer()
    medications = MedicationBreakdownSerializer(many=True)
    current_streak = serializers.IntegerField(
        help_text="Consecutive taken doses ending now; a missed dose ends it."
    )
```

The same `adherence_report` function feeds two consumers (so they can never disagree): the API
(`GET /api/reports/adherence/`, with the access checks and audit of chapter 09) and the **weekly summary email**
(`reports/summary.py` calls `adherence_report(patient, rng, now)` for the finished local week).

## 9. Try it yourself

```bash
pytest reports/tests/test_adherence_service.py -v
```

In the Django shell, call `adherence_report(patient, rng, now)` inside `CaptureQueriesContext` (as in the test) and
print each query. Then change `Count("status", ...)` to `Count("id", ...)` and look at the query plan in chapter
11: the index-only scan disappears.

## Interview questions on this chapter

1. **Q: How is adherence defined?**
   **A:** `taken / (taken + missed) x 100`, rounded to one decimal, over doses that are due (`scheduled_at <=
   now`) and resolved. Late doses count as taken (and are also reported as `taken_late`). Skipped doses are
   reported separately and excluded from the percentage. Pending, reminded and future doses are never counted. If
   there is no taken or missed dose the percentage is `null`.

2. **Q: Why is the percentage `null` instead of 0 in some cases?**
   **A:** With no taken and no missed doses there is no information. Zero would wrongly say the patient took
   nothing. `null` is honest, and clients can show "no data yet".

3. **Q: Why exclude skipped doses from the percentage?**
   **A:** Skipping is a deliberate decision, often medical, not a lapse. Including it as missed would unfairly
   lower the score; including it as taken would inflate it. So it is reported separately for the clinician to
   interpret.

4. **Q: How do you compute four counts efficiently?**
   **A:** With conditional aggregation: `Count("status", filter=Q(...))` becomes `COUNT(status) FILTER (WHERE
   ...)`, so one pass over the rows yields all four counts, both overall (`aggregate`) and per medication
   (`values(...).annotate(...)`). No Python loop over doses.

5. **Q: How many queries does a report take, and does it depend on the data size?**
   **A:** Four, regardless of size: totals, per-medication, latest missed dose, and taken count since then. I
   captured the queries before and after adding 300 doses and both runs were four. A test asserts a one-day and a
   thirty-day report use the same number.

6. **Q: What is the N+1 query problem?**
   **A:** Running one query for a list and then one more per item (for example loading each dose's medication
   separately). The cost grows with the data. This report uses aggregation and one join so the query count is
   constant.

7. **Q: Why does the code count `status` instead of `id`?**
   **A:** `status` is not null, so `COUNT(status)` equals `COUNT(*)`, and the covering index `dose_patient_cover_idx`
   includes `status` but not `id`. Counting `id` would force a table visit and lose the index-only scan.

8. **Q: How is the streak computed without iterating?**
   **A:** Find the latest missed dose (`MAX(scheduled_at)` where status is missed), then count taken doses after
   it. With no missed dose, count all taken doses. Skipped, pending and future doses are ignored. It is two
   aggregate queries and does not depend on the report range.

9. **Q: Why is the date range converted with local midnights and a half-open interval?**
   **A:** The patient's calendar day decides which period a dose belongs to, including 23 and 25 hour daylight
   saving days. `[start, end)` between local midnights means every dose belongs to exactly one day and adjacent
   ranges do not double count the boundary.

10. **Q: Why limit the range to 366 days?**
    **A:** To bound the work of one request and prevent an unbounded query. 366 covers a full year including a
    leap year; longer asks get a 400 with a clear message.

## Common mistakes to avoid

* **Counting open doses as missed.** A pending or reminded dose is unresolved, and a future dose has not happened.
* **Computing the percentage with skipped in the denominator.** The definition excludes it.
* **Returning 0% when there is no data.** Return `null` and say why.
* **Looping over doses in Python.** Let the database aggregate; the result is four queries however big the
  history.
* **Leaving the default `ordering` on an aggregate query.** It can leak into `GROUP BY` and split groups;
  that is why the code calls `.order_by()`.
* **Using UTC dates for a patient's period.** Use the patient's local midnights, and half-open intervals.
* **Documenting a metric without its definition.** The API returns `definition` with every report on purpose.
* **Letting the streak depend on the chosen range.** It is "as of now", by definition.

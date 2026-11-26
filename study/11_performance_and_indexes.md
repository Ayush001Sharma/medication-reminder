# 11. Performance and indexes

A system that sends reminders every minute and answers a report in milliseconds has to stay fast as the data
grows. In this project the data that grows without limit is the **dose table**: a patient with 3 doses a day
adds about 1,000 rows a year, and 1,000 patients add a million rows a year. This chapter explains each index on
the dose and notification tables, the exact query that needs it, and the `EXPLAIN` evidence, with numbers.

All timings below are from **my own runs** on this machine (PostgreSQL 16, a scratch database with 1,000,000
doses and 300,000 notification logs). Absolute milliseconds differ on other computers; the **ratios and buffer
counts** are the lesson.

## 1. First principles

### What an index is

A table is stored as a pile of pages (8 KB blocks). To find "the doses of patient 501 last week" without an
index, PostgreSQL must read **every page** and test each row: a **sequential scan**. An **index** is a separate,
sorted structure (a **B-tree**) that maps column values to row locations, like the index at the back of a book:
look the word up and jump straight to the pages. A lookup costs roughly "tree height" page reads (a handful)
instead of "table size".

### Kinds of scans you will see in a plan

| Plan node | Meaning |
|---|---|
| **Seq Scan** | Read the whole table |
| **Index Scan** | Walk the index, then fetch each matching row from the table |
| **Bitmap Index Scan + Bitmap Heap Scan** | Collect matching row locations from the index, then read table pages in order |
| **Index Only Scan** | Answer entirely from the index; **no table access** |

### Three index tricks used in this project

* **Composite index** `(patient_id, scheduled_at)`: sorted by patient, then time, so "this patient's doses in a
  time range" is one contiguous slice.
* **Partial index** (`WHERE ...`): contains **only the rows matching a condition**. If almost all rows are history
  you never scan, leaving them out makes the index tiny and the queries fast.
* **Covering index** (`INCLUDE (...)`): stores extra columns in the index so a query needing only those columns
  never visits the table (an index-only scan).

### The cost of an index

Indexes take **disk space** and must be **updated on writes** to the rows they cover. The rule is therefore:
**add an index for a specific, measured query, not "just in case"**. Every index here is tied to a named query.

### How to measure: `EXPLAIN (ANALYZE, BUFFERS)`

* `EXPLAIN` shows the plan PostgreSQL would use. `EXPLAIN ANALYZE` runs the query and shows real times and rows.
* `BUFFERS` adds **shared hit / read**: how many 8 KB pages were touched (`hit` = already in memory, `read` =
  fetched from disk). **Buffers are the most stable measure**, because they do not depend on how fast your
  computer is.

Reading one real plan line:

```text
Index Only Scan using dose_patient_cover_idx on scheduling_doseevent [0.060 ms, rows=270, loops=1]
```

It names the node, the index, the actual time, the rows returned and how many times the node ran (`loops`).
A line such as `Index Scan ... [0.003 ms, rows=0, loops=1000]` means "this lookup was repeated 1,000 times",
which is how a plan hides a cost that grows with the number of patients.

## 2. The hot queries

| Label | Query | How often | Code |
|---|---|---|---|
| **A** | Claim due doses | every minute | `claim_due_doses` in `notifications/services.py` |
| **B** | Mark overdue doses missed | every 5 minutes | `mark_missed_doses` |
| **C / C2** | Adherence report, 90 days / 366 days | each report view | `adherence_report` in `reports/services.py` |
| **D** | Streak: latest missed dose | each report view | `current_streak` |
| **E** | A patient's doses today | each app open | `DoseViewSet.today` in `scheduling/views.py` |
| **F** | Retries and stuck sends | every minute | `reserve_retries_and_stuck` |

## 3. The indexes

**Before** (the first migrations): `dose_status_time_idx (status, scheduled_at)`, `dose_patient_time_idx
(patient_id, scheduled_at)` and `notif_status_next_idx (status, next_attempt_at)`. General purpose, and each
indexes the **whole history**.

**After** (`scheduling/migrations/0005_query_indexes.py`, `notifications/migrations/0002_query_indexes.py`):

*From `scheduling/models.py`, `DoseEvent.Meta.indexes`:*

```python
        indexes = [
            # Hot path, every minute: "open" doses that are due. Partial, so it holds only the
            # few upcoming doses (tiny) instead of the whole history, and the claim and the
            # missed-dose job no longer scan per patient.
            models.Index(
                fields=["scheduled_at"], name="dose_open_idx",
                condition=Q(status__in=["pending", "reminded"]),
            ),
            # A patient's doses in a time range (today / upcoming / reports). INCLUDE carries the
            # columns the report aggregates, so the report is an index-only scan.
            models.Index(
                fields=["patient", "scheduled_at"], name="dose_patient_cover_idx",
                include=["status", "medication", "taken_late"],
            ),
            # "Latest missed dose" for the streak, constant time even for patients who never miss.
            models.Index(
                fields=["patient", "scheduled_at"], name="dose_patient_missed_idx",
                condition=Q(status="missed"),
            ),
        ]
```

*From `notifications/models.py`, `NotificationLog.Meta.indexes`:*

```python
        indexes = [
            # Only unfinished sends are ever scanned (retries / stuck leases). Partial, so the
            # millions of finished rows are not in the index and finishing a send removes its entry.
            models.Index(
                fields=["next_attempt_at"], name="notif_sending_idx",
                condition=Q(status="sending"),
            ),
        ]
```

## 4. How the experiment was built

So you can repeat it: a **scratch** database (never your real one), the project's real migrations, then 1,000
patients x 1,000 doses = 1,000,000 doses, and 300,000 notification logs where almost all are finished and 150 are
still `sending` (the rows the retry scan must find). The queries are the project's **real ORM queries**,
explained with `qs.explain(analyze=True, buffers=True)`.

```bash
createdb perf_study                                      # a scratch database
DATABASE_URL=postgres://USER:PASS@localhost:5432/perf_study python manage.py migrate
psql perf_study -f load.sql                              # bulk INSERT ... SELECT generate_series(...)
```

The data loader used `INSERT ... SELECT ... FROM generate_series(...)` to create users, profiles, one medication
per patient and 1,000 doses each (3 a day, from about 323 days ago to 10 days ahead, with a realistic mix of
`taken`, `missed` and `skipped`), then `ANALYZE` so the planner has statistics. (I kept the loader outside the
repository, as it is only a measuring tool.)

## 5. Results

I measured each query under the **old** indexes and the **new** ones, in an **idle minute** (nothing due) and for
A also in a **busy minute** (1,000 doses due at once, which happened to be true right after my data load).

### Summary table (idle minute)

| Query | Before | After | What changed |
|---|---|---|---|
| **A. Claim due doses** | 4.25 ms, **4,032 buffers** | **0.28 ms, 18 buffers** | Old plan probed the patient index **1,000 times** (`loops=1000`), once per patient. New plan reads the tiny partial index once |
| **B. Mark overdue missed** | 0.075 ms, 6 buffers | 0.052 ms, 2 buffers | Same partial index; was already small |
| **C. Report, 90 days** | 1.18 ms, 277 buffers (bitmap heap scan) | **0.15 ms, 9 buffers** (index-only scan) | Covering index answers the aggregate without touching the table |
| **C2. Report, 366 days** | 2.15 ms, 976 buffers | **0.34 ms, 11 buffers** | Same |
| **D. Streak, worst case** (patient who never missed) | 2.86 ms (walked all of the patient's history) | **0.05 ms** | Partial index on missed doses only |
| **E. Today's doses** | about 0.06 ms | about 0.06 to 0.12 ms | Already fast; no meaningful change (differences below 1 ms are noise) |
| **F. Retries / stuck sends** | 0.64 ms, 453 buffers | about 0.7 to 1.0 ms, 451 buffers | No faster, but the index is far smaller (below) |

### Query A in a busy minute

| | Before | After |
|---|---|---|
| 1,000 doses due, batch of 200 | 13.0 ms, 7,432 buffers | 4.3 ms, 6,415 buffers |

Here the work is dominated by really processing 1,000 due rows, so the gain is smaller (about 3 times). The
important point is the **idle** case: that is what happens in almost every minute of the day, and it fell from
4,032 buffers to 18.

### Why A improved, in plan form (trimmed)

Before (idle minute):

```text
Hash Right Join ...
  -> Seq Scan on accounts_patientprofile ...
  -> Seq Scan on accounts_user ...
  -> Index Scan using dose_patient_time_idx on scheduling_doseevent [0.003 ms, rows=0, loops=1000]
Execution Time: 4.247 ms      Buffers: shared hit=4032
```

After:

```text
Hash Join
  -> Index Scan using dose_open_idx on scheduling_doseevent [0.144 ms, rows=0, loops=1]
  -> Hash (never executed)
Execution Time: 0.278 ms      Buffers: shared hit=18
```

Before, the planner started from the *patients* and looked up each patient's doses (1,000 probes). With the
partial index it starts from the **due doses** (usually none), so the patient tables are "never executed". The
cost no longer grows with the number of patients.

### Why C improved

```text
BEFORE  HashAggregate -> Bitmap Heap Scan on scheduling_doseevent (rows=270)  -> Bitmap Index Scan on dose_patient_time_idx
        Buffers: shared hit=277
AFTER   HashAggregate -> Index Only Scan using dose_patient_cover_idx on scheduling_doseevent (rows=270)
        Buffers: shared hit=9
```

The report needs only `status`, `medication` and `taken_late` from each dose, and the covering index carries
exactly those. The "Bitmap Heap Scan" visits the table pages (277 of them); the "Index Only Scan" does not
(9). This is also why `_COUNTS` in `reports/services.py` counts the `status` column and not `id` (chapter 10):
`id` is not in the index, and counting it would force the table visit back.

### Why D improved

For a patient who **never** missed a dose, "find the latest missed dose" has no answer. With the general
`(patient, scheduled_at)` index PostgreSQL walks backwards through *all* of that patient's doses looking for one
with status `missed`, finds none, and stops at the end (2.86 ms and growing with history). The partial index
`dose_patient_missed_idx` contains **only missed doses**, so for this patient it is empty and the answer is
immediate (0.05 ms), however long their history. That is what the model comment means by "constant time even
for patients who never miss".

## 6. Size and write cost (the honest trade-off)

Measured with `pg_relation_size`:

| Index | Size | Comment |
|---|---|---|
| `dose_status_time_idx` (old) | 7.3 MB | Whole history |
| `dose_patient_time_idx` (old) | 30 MB | Whole history |
| `notif_status_next_idx` (old) | 2.2 MB | Includes every finished log |
| `dose_open_idx` (new) | **240 kB** | Only pending and reminded doses |
| `dose_patient_cover_idx` (new) | 56 MB | About twice the old patient index (the price of `INCLUDE`) |
| `dose_patient_missed_idx` (new) | 2.4 MB | Only missed doses |
| `notif_sending_idx` (new) | **16 kB** | Only unfinished sends |
| (the table itself) | 89 MB | |

* The two partial indexes are **tiny** next to the old ones (240 kB against 7.3 MB; 16 kB against 2.2 MB), and a
  finished send simply **leaves** the notification index, so it stays small however many logs pile up.
* The covering index is **bigger** (56 MB against 30 MB) because it stores three extra columns per entry. That
  is a real cost of the design, accepted because it removes table visits for the report. I did **not** measure
  the effect on write speed; in general, more and wider indexes make inserts and status updates a little more
  expensive.

## 7. Creating indexes safely on a live table

*From `scheduling/migrations/0005_query_indexes.py`:*

```python
"""Indexes for the hot queries (see the "Indexes" section of the README for the measurements).
Built CONCURRENTLY (``atomic = False``) so a large production table is not locked while an
index is created, and the new indexes are added before the old ones are dropped, so there is
never a moment without a usable index.
"""
```

A normal `CREATE INDEX` blocks writes to the table while it builds. `AddIndexConcurrently` builds without that
lock (it cannot run inside a transaction, hence `atomic = False`). The migration **adds the new indexes first and
only then removes the old ones**, so queries always have an index. This is the habit to describe in an interview:
*schema changes on a big, live table must not cause downtime.*

## 8. Why "the planner will choose it" is not enough

PostgreSQL chooses a plan from **statistics** about the table. Which index it prefers can change with the data. A
real CI failure in this project showed it: when the statistics said "one patient owns the whole table", the
planner chose the foreign-key index on `medication_id` instead of the covering index. Chapter 13 tells that story
and explains how `tests/test_indexes.py` checks "is index X usable for this query?" instead of "did the planner
pick X?", so the tests do not depend on statistics.

## 9. Try it yourself

```bash
pytest tests/test_indexes.py -v          # the index guard tests
```

On a scratch database with some data, run in `psql`:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT scheduled_at FROM scheduling_doseevent
WHERE patient_id = 501 AND status = 'missed' AND scheduled_at <= now()
ORDER BY scheduled_at DESC LIMIT 1;
```

Drop `dose_patient_missed_idx` (on the scratch copy only!) and run it again to watch the plan change.

## Interview questions on this chapter

1. **Q: What is a database index, and what does it cost?**
   **A:** A sorted structure (a B-tree) that lets the database find rows without reading the whole table. It
   costs disk space and slows writes, because every insert or update to the indexed columns must also update the
   index. So you index specific, measured queries.

2. **Q: What is a partial index and where do you use one here?**
   **A:** An index over only the rows matching a condition. `dose_open_idx` covers only pending and reminded
   doses and `notif_sending_idx` only unfinished sends, so they stay tiny (240 kB and 16 kB) while the history
   grows into millions of rows that those queries never need.

3. **Q: What is a covering index and what did it buy?**
   **A:** An index that also stores extra columns (`INCLUDE`). `dose_patient_cover_idx` holds `status`,
   `medication` and `taken_late`, so the report is an index-only scan: 9 buffers instead of 277 in my 90-day
   test. The cost is a larger index (56 MB against 30 MB).

4. **Q: How do you read `EXPLAIN (ANALYZE, BUFFERS)`?**
   **A:** From the inside out. Look at the scan types (seq, index, bitmap, index-only), the actual row counts and
   times, and `loops` for repeated work. `Buffers` shows pages touched, a stable measure of I/O. I look for seq
   scans on big tables and for nodes with large loops.

5. **Q: What was wrong with the claim query before, and how did you see it?**
   **A:** The plan started from the patients and probed the dose index once per patient (`loops=1000`), so it
   scaled with the number of patients even when nothing was due: 4,032 buffers. With the partial index on open
   doses the plan starts from due doses, usually none, and used 18 buffers.

6. **Q: Why count `status` rather than `id` in the report?**
   **A:** `status` is in the covering index and is not null, so `COUNT(status)` equals `COUNT(*)` and the query
   stays an index-only scan. `id` is not in the index, so counting it would force table visits.

7. **Q: Why was the streak query slow for patients who never miss?**
   **A:** With a general patient and time index, finding the latest missed dose walks backwards through all of
   that patient's doses and finds none. A partial index on missed doses only is empty for them, so the answer is
   immediate, however long the history.

8. **Q: How do you add an index to a large production table without downtime?**
   **A:** Build it concurrently (`AddIndexConcurrently`, non-atomic migration) so writes are not blocked, add the
   new index before dropping the old one so there is never a time without a usable index, and test on a copy.

9. **Q: Why might a plan test be flaky and how did you avoid it?**
   **A:** The planner picks indexes from statistics, which vary with data and maintenance. Instead of asserting
   which index it chose, the tests ask whether the intended index is *usable*: they hide competing indexes inside
   the test transaction and assert that the query can use the one that matters.

10. **Q: Your numbers came from one machine. Why trust them?**
    **A:** I rely on buffer counts and plan shapes, which are stable, more than on milliseconds. I also repeated
    the measurements and I describe the data and the method so anyone can reproduce them. Small differences below
    a millisecond I treat as noise.

## Common mistakes to avoid

* **Indexing everything "just in case".** Each index costs space and write time; justify each with a query.
* **Judging by milliseconds on a small dataset.** Test with realistic volume (here, a million rows) and prefer
  buffers and plan shape.
* **Ignoring `loops`.** A cheap node run 1,000 times is a 1,000 times cost.
* **Forgetting that a partial index only helps queries whose `WHERE` implies its condition.** The claim query
  filters `status = pending`, which fits `status IN (pending, reminded)`.
* **Running `CREATE INDEX` without `CONCURRENTLY` on a live table.** It blocks writes.
* **Asserting which index the planner "picked" in tests.** It depends on statistics; test usability instead.
* **Dropping the old index before the new one exists.** Add first, then drop.
* **Testing performance on the real database.** Use a scratch copy and never `UPDATE` real data to set up an
  experiment.

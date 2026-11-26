# 13. Testing strategy

A reminder system that "mostly works" is dangerous, so the tests are part of the design, not an afterthought.
This chapter explains the kinds of tests in the project, how real threads are used to prove concurrency
guarantees, how **breaking the code on purpose** shows that tests are not empty, and two real stories where a test
failed in CI and what they taught.

## 1. First principles

### Why test at all, and what makes a test good?

A test is a small program that checks that code does what you claim. A **good** test:

* fails when the behaviour it protects breaks (a test that can never fail is worthless);
* passes reliably when the code is right (a test that sometimes fails for no reason is **flaky** and teaches
  people to ignore failures);
* says clearly what broke.

### Kinds of tests (a pyramid)

| Kind | Example here | Speed | What it catches |
|---|---|---|---|
| **Unit** (a pure function) | `local_to_utc` with Kolkata and New York dates | very fast | Logic errors |
| **API / integration** (HTTP into the app with a real database) | register, login, mark a dose taken | fast | Wiring, validation, permissions |
| **Concurrency** (real threads, real PostgreSQL) | two workers racing for one dose | slower | Race conditions |
| **Configuration** (start the app with bad settings) | refuses a short secret key | medium | Startup safety |
| **Plan / schema** | the right index can be used by a real query | medium | Performance regressions |
| **Frontend** (Vitest, Testing Library, axe) | Today page actions, forms, accessibility | fast | UI behaviour |

The project has **460 backend tests** (by area: `accounts` 82, `medications` 14, `scheduling` 98,
`notifications` 54, `reports` 73, and 139 in the top-level `tests/` folder) and **450 frontend tests**. Coverage
(lines and branches, measured with `pytest-cov`) is about **99.4 to 99.5%**, and CI **fails below 95%**. Coverage
only says which lines ran, not that they are *checked*, which is why the next sections matter more.

## 2. How the suite is set up

*From `pytest.ini`:*

```ini
[pytest]
DJANGO_SETTINGS_MODULE = config.settings
python_files = tests.py test_*.py *_tests.py
norecursedirs = frontend node_modules .* build dist venv
```

* **Real PostgreSQL**, not SQLite or mocks: the guarantees (row locks, partial indexes, constraints) only exist
  there. `pytest-django` creates a temporary test database (the role needs `CREATEDB`).
* **Shared fixtures** live in the root `conftest.py`: `patient`, `other_patient`, `patient_api` (an
  authenticated API client), and a `celery_eager` fixture that runs every Celery task immediately in the calling
  thread so no broker is needed:

*From `conftest.py`, `celery_eager`:*

```python
@pytest.fixture(autouse=True)
def celery_eager():
    """Run Celery tasks in-process (and in the calling thread) during tests."""
    from config.celery import app

    app.conf.task_always_eager = True
    app.conf.task_eager_propagates = True
    yield
```

* **Each test runs in a transaction that is rolled back**, so tests do not pollute each other. The exception is
  concurrency tests, which need real commits (section 4).
* **Deterministic time.** Functions take `now` as a parameter (`generate_dose_events(..., now=...)`,
  `claim_due_doses(now=...)`), so tests control the clock instead of sleeping.

### Test order matters (a fact that explains a bug later)

`pytest-django` reorders tests: first normal database tests, then **transactional** ones (`transaction=True`),
then tests that use **no database**. I read this in its plugin (`get_order_number` returns 0, 1 and 2). So
concurrency tests run late, and plain tests such as `test_ping_task_runs_eagerly` run last. Keep this in mind for
the story in section 7.

## 3. Testing the tricky logic with exact examples

The strongest tests are specific. `scheduling/tests/test_dose_generation.py` asserts the exact UTC instants for
Kolkata, the spring-forward day, the fall-back day, the nonexistent 02:30 and the ambiguous 01:30 (chapter 06).
`reports/tests/test_adherence_service.py` asserts the percentage formula and the streak rules (chapter 10). When
the expected answer is written down as a number, the test cannot be "nearly right".

## 4. Concurrency tests with real threads

A race condition cannot be proven absent by running code once. So the project tests with **real threads, each with
its own PostgreSQL connection, really contending for row locks. Nothing is mocked.** The module docstring says so:

*From `notifications/tests/test_concurrency.py`:*

```python
"""Concurrency proofs with REAL threads, each with its own PostgreSQL connection.

``transaction=True`` makes these transactional tests: data is really
committed, so the threads see it and really contend for row locks. Nothing
here is mocked.
"""
```

The helper that starts threads **together** (so they truly overlap) and collects results:

*From `notifications/tests/test_concurrency.py`, `run_concurrently`:*

```python
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
```

Points to explain:

* **The barrier** makes every thread wait until all are ready, then releases them at the same moment, which
  maximises the overlap.
* **`connection.close()`** in each thread: Django connections are per thread, so each thread opens and closes its
  own.
* **Errors in threads are collected** and re-raised in the main thread, otherwise a thread's exception would be
  swallowed and the test would pass wrongly.
* **`transaction=True`** (the `django_db` marker) is essential: with the default rolled-back transaction the
  threads would not see each other's data.

What they prove:

| Test | Proves |
|---|---|
| `test_two_workers_at_once_send_exactly_one_reminder` | Two workers dispatching at once send one email per dose |
| `test_many_workers_many_doses_each_reminded_exactly_once` | 8 workers x 30 doses: 30 distinct emails |
| `test_locked_dose_is_skipped_not_waited_for` | `SKIP LOCKED` really skips (timing and ordering with events) |
| `test_same_delivery_task_running_twice_at_once_sends_once` | 4 threads on one lease token: one `sent`, three `skipped` |
| `test_concurrent_recovery_of_a_stuck_send_sends_once` | 4 recoverers: one send |
| `test_marking_missed_never_overwrites_a_dose_taken_concurrently` | The missed job waits and then leaves a taken dose alone |
| `scheduling/tests/test_dose_concurrency.py` | 6 simultaneous "taken" requests change the dose exactly once |
| `accounts/tests/test_access_grants.py::test_simultaneous_invites_create_exactly_one_grant` | The partial unique constraint holds under a race |

## 5. How breaking the code on purpose proves the tests work

**Mutation testing by hand.** Take a line of production code that protects a guarantee, change it to break the
guarantee, run the tests, and see whether *something fails*. If everything still passes, the tests are not really
guarding that line. After the experiment you undo the change. I ran these on this repository; the results are
real.

| Change made (then undone) | Tests that failed |
|---|---|
| `local_to_utc` builds the datetime with `tzinfo=UTC` instead of the patient's zone | **16 failed** in the three dose test files I ran (generation, sync, API), including Kolkata, both New York days, the gap and the overlap |
| `mark_taken` without the "already taken, return unchanged" check | **3 failed**: `test_marking_taken_twice_is_idempotent`, `test_using_the_link_twice_is_safe`, `test_simultaneous_taken_requests_change_the_dose_exactly_once` |
| The access check also counts `revoked` grants as active | **4 failed**, including `test_revoking_takes_effect_on_the_very_next_request_with_the_same_token` |
| The report view swallows a failing audit write | **1 failed**: `test_no_data_is_returned_if_the_audit_write_fails` |
| The report counts `id` instead of `status` | **1 failed**: `tests/test_indexes.py::test_report_never_counts_the_primary_key` |
| `claim_due_doses` loses `skip_locked=True` | **1 failed**: `test_locked_dose_is_skipped_not_waited_for` |
| `_acquire` no longer compares the lease token | **1 failed** (the real-thread test), the other 53 notification tests still passed |
| `claim_due_doses` no longer sets doses to `reminded` | **22 failed** |

Two lessons:

1. **Some guarantees are held by exactly one test.** Removing the token comparison in `_acquire` is caught
   **only** by the concurrent test, because every sequential test passes (after the first send the row is no
   longer `sending` anyway). Without real-thread tests this bug would ship. That is why they exist.
2. **Good tests fail for the right reason.** Each failure above names the behaviour that broke, so a developer
   knows what to fix.

Try this yourself on a scratch branch: it is the fastest way to understand what a test protects.

## 6. Story 1: the planner-dependent index test

**What happened.** The project guards its indexes (chapter 11) with tests that check a real query uses the
intended index. An early version asserted "the planner chose index X". It failed once **in CI** while passing on
the developer's machine.

**Root cause.** PostgreSQL's planner picks an index from **statistics** about the tables, and those depend on
data and maintenance (`ANALYZE`, leftovers from earlier tests). In CI the statistics said "one patient owns the
whole table", so the planner preferred the foreign-key index on `medication_id` (which delivers rows already
sorted for the `GROUP BY`) over the covering index. Nothing was wrong with the code; the test asked a question
whose answer is not fixed. The test's own docstring records this:

*From `tests/test_indexes.py`, module docstring:*

```python
Which index PostgreSQL *prefers* depends on table statistics and maintenance (``ANALYZE``, ``VACUUM``,
leftovers from earlier tests), so a test that asserts "the planner picked index X" is a coin flip on a test
database. A real CI failure proved it: when statistics said "one patient owns the whole table", the planner
chose the ``medication_id`` foreign-key index (it delivers rows already sorted for the GROUP BY) instead of the
covering index.
```

**The fix** (commits `20a5e92` and `6b72e1d`): ask a question that has **one answer whatever the statistics
are**: *"Is index X usable for this query?"*

*From `tests/test_indexes.py`, `assert_searched_by` and its use:*

```python
def assert_searched_by(plan_text: str, index: str, pattern: str) -> None:
    """The index is used AND its search condition matches ``pattern``.

    Appearing in a plan is not enough: a btree can be scanned in full using a non-leading column, which is
    correct but slow. Checking the condition proves the index is used for what it was built for (for example
    that ``patient_id`` is the leading column of the lookup).
    """
    assert index in plan_text, f"{index} not used:\n{plan_text}"
    assert re.search(pattern, index_conditions(plan_text)), (
        f"{index} is used, but not searched by /{pattern}/:\n{plan_text}"
    )
```

```python
def test_claim_query_can_use_the_open_dose_index(table_statistics):
    only_usable_index(DOSES, "dose_open_idx")
    assert_searched_by(plan(claim_query()), "dose_open_idx", r"scheduled_at >=")  # a bounded range, not a full scan
```

How it works: inside the test's own transaction, `only_usable_index` **drops every other index on the table**
(PostgreSQL's DDL is transactional, so the rollback restores them all) and `plan()` switches sequential scans off.
The only valid plan that touches the table must then use the index under test; and `assert_searched_by` also
checks the index is searched by the right condition. No competing index can win.

Further defences:

* **`table_statistics`**, a fixture with three parameters, runs every plan test under three different sets of
  planner statistics: `empty_tables`, `one_patient_owns_everything` (the state that caused the CI failure) and
  `many_patients`. If a test depended on statistics, one of them would fail.
* **Negative controls** (`test_a_query_outside_the_index_predicate_cannot_use_it`): a query whose `WHERE` does
  **not** imply the partial index's condition must *not* be able to use that index. This proves the checks can
  fail, so they are not vacuous.
* **Catalog tests** (`test_expected_indexes_exist_with_the_right_shape`) check the index definitions directly, with
  no planner involved.

One honest weakness: the plan tests define their own copies of the query shapes (`claim_query()`,
`latest_missed_query()`, ...) rather than importing them from the application, so a change to the application
query would not automatically change the test query. (The one exception, the primary-key count, runs the real
`adherence_report`.)

**The lesson to state in an interview:** *do not assert an implementation choice that depends on external state;
assert the property you actually care about, and add a negative control so the test can fail.*

## 7. Story 2: the Celery eager-mode thread-safety flaky test

**What happened.** A CI run failed on **Python 3.12 only** (3.13 and the frontend passed) with two failures:
`test_same_delivery_task_running_twice_at_once_sends_once` and `test_ping_task_runs_eagerly`, both with
`RuntimeError: Never call result.get() within a task!`. It looked like a Python version problem. It was not.

**Root cause.** Celery guards against calling `result.get()` inside a task using **one process-wide boolean**. In
eager mode every `task.delay()` raises it for the length of the task with a context manager that **saves the old
value and restores it afterwards**, with no lock. The concurrency tests above launch tasks from several threads on
purpose, so two windows can overlap and the restores can happen out of order:

```text
thread A reads False, sets True        thread B reads True (A's value), sets True
thread A leaves: restores False        thread B leaves: restores True   <- stuck on True
```

The flag is now stuck on `True`, and every later `.get()` on an eager result fails, in whatever unrelated test
runs next. Because of the test ordering in section 2, the victims were the last concurrency tests and
`test_ping_task_runs_eagerly`, which runs at the very end.

**How it was proven, not guessed:**

* A 30-line script with two threads and events forces the bad interleaving and shows the flag stuck on `True`
  after both threads finish, on **both** Python 3.12.3 and 3.13.18. So the flaw is in Celery, not in a Python
  version.
* The failure is rare locally (it needs the overlap); running the concurrency tests under coverage on Python 3.12
  reproduced it in 2 of 42 runs with exactly the two CI failures, and a trace showed the flag getting stuck during
  `test_many_workers_many_doses_each_reminded_exactly_once`. On 3.13 the unfixed code passed 46 of 46 runs, which
  is not enough to claim it is immune, and the deterministic script fails there too. Coverage slows every thread
  and makes the overlap likelier, and CI runners are slower, which is why it surfaced in CI.
* Production is unaffected: eager mode is only switched on by the test fixture.

**The fix** (commit `013676b`), in `conftest.py`: replace Celery's context manager with a **locked, counting**
one, so the flag is restored only when the **last** overlapping task leaves:

*From `conftest.py`, `thread_safe_denied_join_result`:*

```python
@contextmanager
def thread_safe_denied_join_result():
    """Drop-in for celery.result.denied_join_result that cannot leave the flag stuck when used from many threads."""
    with _guard_lock:
        if _guard["holders"] == 0:
            _guard["saved"] = task_join_will_block()
            _set_task_join_will_block(True)
        _guard["holders"] += 1
    try:
        yield
    finally:
        with _guard_lock:
            _guard["holders"] -= 1
            if _guard["holders"] == 0:
                _set_task_join_will_block(_guard["saved"])
```

Plus a fixture that makes any future leak fail **in the test that causes it**, not in a random later one:

*From `conftest.py`, `celery_join_guard_is_clean`:*

```python
@pytest.fixture(autouse=True)
def celery_join_guard_is_clean():
    """Fail the test that leaves Celery's join guard raised, instead of a random innocent test that runs later."""
    assert not task_join_will_block(), "Celery's join guard was already raised when this test started"
    yield
    if task_join_will_block():
        _set_task_join_will_block(False)  # do not cascade into every following test
        pytest.fail("this test left Celery's 'no result.get() inside a task' guard raised (see conftest.py)")
```

and nine deterministic regression tests in `tests/test_celery_join_guard.py` (including one that shows Celery's
own guard really can stick, and one that shows a task still cannot wait on another task's result, so the
protection was not simply switched off).

**What was *not* done** (the rules from the request): no test was skipped or weakened and the coverage floor
stayed at 95%. The full suite then passed 6 of 6 times on Python 3.12 and 6 of 6 on 3.13 with the CI flags, and
a 30-run stress on each (coverage on, aggressive thread switching) was clean.

**The lessons:** (1) a failure on one Python version is not automatically a Python difference; reproduce it;
(2) flaky means a real race exists somewhere (here in the test harness's use of a library's global state);
(3) fix the cause, add a deterministic regression test, and make the next occurrence fail loudly at its source.

## 8. More kinds of backend tests

* **Configuration tests** (`tests/test_settings_validation.py`) start Django in a subprocess with bad settings and
  assert it fails with a clear message (chapter 12). `tests/test_configuration.py` keeps `.env.example` and the
  README in step with the code.
* **Logging tests** (`notifications/tests/test_logging.py`) assert events and that no personal data appears.
* **Health, CORS and rate-limit tests** under `tests/` (chapter 12).
* **Seed command test** (`accounts/tests/test_seed_demo.py`) keeps the demo data command working.

## 9. Frontend tests (briefly)

450 tests in `frontend/` with Vitest and Testing Library: pure logic (dates, doses, medication validation), every
component, each page's loading, empty and error states, the API client's refresh-once behaviour, an `axe-core`
accessibility audit, a design-token test that fails on stray colours, and a test that **builds the app for real**
without the demo flag and fails if any demo text is in the output (chapter 15). Contrast and layout were also
checked in a real browser with Playwright against the real backend (those scripts are not part of the repository).

**A frontend flaky test, found and fixed.** In one of nine full frontend runs the test `ReportPage: asks for the default
range` failed after about 1,053 ms, close to the 1 second default timeout of `findBy`. The cause was then proven: the page loads
its charts with `React.lazy`, and the first dynamic import of Recharts in a test worker took about 747 ms when the test ran alone
(the later tests took about 83 ms), so under load the first test that showed a chart could exceed the second. The fix waits for
the real condition instead of raising a timeout: a `beforeAll` in `ReportPage.test.tsx` awaits the import of both chart modules,
so every test only waits for rendering (the first test now takes about 133 ms). After the fix the whole frontend suite passed
15 times out of 15.

## 10. Running the tests

```bash
pytest                                              # everything
pytest scheduling/tests/test_dose_generation.py -v  # one file, verbose
pytest -k concurrency                               # by name
pytest --cov --cov-report=term-missing              # with coverage
cd frontend && npm test                             # frontend
```

## Interview questions on this chapter

1. **Q: How do you test concurrency?**
   **A:** With real threads, each with its own PostgreSQL connection, started together with a barrier so they
   genuinely overlap, against committed data (`transaction=True`). Exceptions in threads are collected and
   re-raised. For example four threads deliver the same lease token and the test asserts one `sent` and three
   `skipped`, and exactly one email.

2. **Q: How do you know your tests would catch a bug?**
   **A:** I break the code on purpose and see what fails. Removing the lease-token comparison makes exactly one test
   fail, the real-thread one; making `local_to_utc` ignore the patient's zone fails 16 tests. If nothing fails
   when I break a guarantee, the guarantee is untested.

3. **Q: Why use a real PostgreSQL rather than SQLite or mocks?**
   **A:** The guarantees I care about are database features: row locks, `SKIP LOCKED`, partial unique and partial
   indexes, `CHECK` constraints. A mock would test my assumptions, not the database.

4. **Q: What is a flaky test and how do you handle one?**
   **A:** One that sometimes fails without a code change. I treat it as a real bug until proven otherwise:
   reproduce it (under load or with a deterministic script), find the shared state or timing, fix the cause, and add
   a deterministic regression test. I never retry or skip it.

5. **Q: Tell me about a CI failure you debugged.**
   **A:** Use the Celery story: failed on Python 3.12 only with `Never call result.get() within a task!`. Celery's
   eager-mode guard is one process-wide boolean saved and restored without a lock; my threaded tests overlapped
   and left it stuck, so a later `.get()` failed. I proved it with a deterministic two-thread script on both
   Pythons, reproduced it under coverage, replaced the context manager with a locked, counting one, added a
   fixture that fails the leaking test, and ran the suite repeatedly on both versions.

6. **Q: Why did the index tests stop asserting which index the planner chose?**
   **A:** The planner chooses from statistics, which vary with data and maintenance, so that assertion was a coin
   flip; CI hit it. Now each test drops all competing indexes inside its own transaction and asserts the intended
   index is usable and searched by the right condition. It runs under three statistics scenarios, and negative
   controls prove the checks can fail.

7. **Q: What does 99% coverage tell you and what does it not?**
   **A:** It tells me which lines ran during tests. It does not tell me the results were checked; a test with no
   assertions gives coverage. That is why I also do mutation experiments and write exact-value assertions.

8. **Q: How do you make time-dependent code testable?**
   **A:** Pass `now` as a parameter (`generate_dose_events(..., now=...)`, `claim_due_doses(now=...)`), so tests
   fix the clock instead of sleeping. That makes the grace window, back-off and lease expiry exact.

9. **Q: Why does test order matter in this project?**
   **A:** `pytest-django` runs normal DB tests, then transactional ones, then tests without a database. A test that
   leaks global state (like Celery's flag) harms whatever runs after, so I added a fixture that checks the state
   after every test and fails the one that leaks it.

10. **Q: What is a negative control?**
    **A:** A test that proves a check can fail. For example, a query whose condition does not imply a partial
    index's predicate must not be able to use that index. Without it, a check that always passes would look the
    same as one that works.

## Common mistakes to avoid

* **Retrying or skipping a flaky test.** It hides a real race.
* **Mocking the database for database guarantees.** You test your belief, not the system.
* **Concurrency tests without a barrier**, which often run sequentially by accident.
* **Swallowing exceptions in worker threads**, which makes broken tests pass.
* **Using the default rolled-back transaction for tests that need other connections to see data.**
* **Asserting planner choices** instead of properties.
* **Trusting coverage numbers** without checking that assertions exist.
* **Leaking global state between tests** (module globals, environment variables, library flags). Check and reset
  it in a fixture.
* **Concluding "it is the Python version" or "it is CI" without reproducing the failure.**

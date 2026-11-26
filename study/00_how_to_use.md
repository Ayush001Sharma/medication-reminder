# 00. How to use this guide

This guide teaches you the **Medication Reminder and Adherence Tracker backend** well enough that you can
(1) understand every important line, and (2) explain it clearly in an interview. It is written for a fresher
who studies alone, so nothing here assumes that someone will answer your questions.

## What the project is, in one sentence

A web service where patients enter their medicines and a schedule, the system emails them a reminder at the
right moment, records what was taken, and lets a caregiver or a doctor see an adherence report, but only for
patients who said yes.

## How the chapters are built

Every chapter follows the same shape:

1. **First principles.** The idea explained from scratch in plain language (what is a token? what is a time
   zone offset?). If you already know a topic, skim it; if you do not, this is the part to read slowly.
2. **The real code.** Short quotes (under 25 lines) from this repository with the file path and the function
   name, so you can open the file and see them in context. Nothing is invented: if a sentence describes
   behaviour, it was read from the code, checked in a test, or run (see "Verified by running" below).
3. **Verified by running.** Boxes that show real output from running the code. Where I was unsure, I ran it
   instead of guessing.
4. **Interview questions on this chapter.** 8 to 10 questions with strong model answers. Cover the answer with
   your hand, answer out loud, then compare.
5. **Common mistakes to avoid.** Things that candidates often get wrong, and traps in this codebase.

### Reading the citations

* `accounts/models.py` is a path from the repository root.
* `local_to_utc` or `AccessGrant.Meta.constraints` names the function, class or attribute inside that file.
* When a quote starts with a line like *From `scheduling/services.py`, `local_to_utc`:* the lines under it
  are copied from that file. Lines with `...` mean "something was left out to keep the quote short".

### The files in this guide

| File | What it covers |
|---|---|
| `00_how_to_use.md` | This file: how to study, and a 7-day plan |
| `01_overview.md` | The problem, users, features, pitches, the architecture, three user journeys |
| `02_tech_stack.md` | Every technology, what it does here, and why it fits |
| `03_data_model.md` | Every table, field, constraint, index and relationship, with an ER diagram |
| `04_auth_and_permissions.md` | Registration, login, JWT, refresh, roles, permission classes, access grants |
| `05_medications_and_schedules.md` | The medication and schedule models, validation, why times are local |
| `06_timezones_and_dose_generation.md` | How doses are generated, idempotency, history, Kolkata and New York DST examples |

The reminder pipeline (claim, lease, retry), the adherence report and the testing strategy are **not** covered
by these seven chapters yet. Chapter 01 introduces them at overview level, and day 7 of the plan below tells
you how to read them yourself using the comments at the top of `notifications/services.py` and
`reports/services.py`, which are unusually good.

## Get the project running (so you can try everything)

You learn far more by running code than by reading about it. These are the commands from the project README
for macOS and Linux (Windows PowerShell steps are in `README.md`):

```bash
git clone https://github.com/Ayush001Sharma/medication-reminder.git
cd medication-reminder
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then edit .env (at least DATABASE_URL and REDIS_URL)
```

Create a PostgreSQL role and database, put the matching `DATABASE_URL` in `.env`, then:

```bash
python manage.py migrate
python manage.py seed_demo          # optional: demo patients, doctor, caregiver, a week of history
pytest                              # runs the whole test suite (needs PostgreSQL)
```

The settings refuse to start without `DATABASE_URL` and `REDIS_URL`; the error message tells you what is
missing (`require_env` in `config/env.py`).

Two ways to experiment safely:

* **The Django shell:** `python manage.py shell`. You can import any function from the guide
  (`from scheduling.services import local_to_utc`) and call it.
* **A rolled-back transaction.** Every "Verified by running" box in this guide was produced inside
  `transaction.atomic()` and ended with `transaction.set_rollback(True)`, so nothing was saved. Copy that
  pattern when you experiment:

```python
from django.db import transaction
with transaction.atomic():
    ...                              # create objects, call services, print results
    transaction.set_rollback(True)   # undo everything when the block ends
```

## How to study (the method)

1. **Read the first-principles part, then close the file** and explain it aloud in your own words, as if to a
   friend. If you get stuck, that is the exact sentence to re-read.
2. **Open the real file.** Find the function that was quoted. Read the lines above and below it.
3. **Run something.** A test (`pytest scheduling/tests/test_dose_generation.py -v`), a shell line, a curl.
4. **Break it on purpose.** Comment out a constraint, a validation or a lock and run the tests. The failing
   tests show what that line protected. This is the fastest way to understand *why* code exists.
5. **Answer the interview questions aloud**, then write the answers you missed on flashcards.
6. **Draw the diagram from memory** (architecture, ER diagram, dose lifecycle). Compare with the chapter.

Rules that save time:

* Do not memorise code. Memorise **ideas and reasons** ("why is the time stored as local clock time?").
* Always attach a reason to a fact: "there is a unique constraint on (schedule, scheduled_at) **so that**
  generating twice cannot create duplicates."
* When you do not know something in an interview, say what you would check and how. The guide teaches you
  where to look.

## 7-day study plan

Plan for about 2 to 3 hours a day. Adjust freely; finishing order matters more than speed.

| Day | Read | Do | You are done when you can... |
|---|---|---|---|
| **1** | `01_overview.md` | Get the project running. Run `seed_demo`. Open `http://localhost:8000/api/docs/`. Say both pitches aloud, twice. | ...explain the problem, the three roles, and trace the "reminder" journey without notes. |
| **2** | `02_tech_stack.md` | Open `requirements.txt` and `config/settings.py`; find where each technology is configured. Run `curl localhost:8000/health/`. | ...say what Django, DRF, PostgreSQL, Redis, Celery and Beat each do here, and one reason for each. |
| **3** | `03_data_model.md` | Run `python manage.py showmigrations` and `python manage.py sqlmigrate scheduling 0002`. Draw the ER diagram from memory. | ...name every table and say what each constraint protects. |
| **4** | `04_auth_and_permissions.md` | Register, log in and call `/api/me/` with `curl` (examples are in the README). Decode a token at jwt.io to see its claims. | ...explain access vs refresh tokens, and why a doctor gets 403 on medications but 404 on an ungranted patient. |
| **5** | `05_medications_and_schedules.md` | Create a medication and a schedule through Swagger. Send invalid data on purpose and read each error. | ...list the validation rules and explain why times are stored as local clock times. |
| **6** | `06_timezones_and_dose_generation.md` | In the shell, run `local_to_utc` for New York on 7, 8 and 9 March 2026. Run the tests in `scheduling/tests/test_dose_generation.py`. | ...walk through the Kolkata and New York examples and explain idempotency. |
| **7** | Review, then read the parts not yet covered | Read the docstring at the top of `notifications/services.py` and `reports/services.py`. Do a mock interview: pick 10 questions at random from the chapters. | ...give the 2-minute pitch and answer follow-ups on time zones, concurrency and access control. |

### A daily rhythm that works

* 10 minutes: re-answer yesterday's interview questions from memory.
* 60 to 90 minutes: read the chapter and open the code.
* 30 minutes: run and break things.
* 20 minutes: write 5 flashcards (question on one side, a two-sentence answer on the other).

## Terms you will see in every chapter

| Term | Plain meaning |
|---|---|
| **Request / response** | The client (browser, app, curl) asks; the server answers. |
| **Endpoint** | One URL the API offers, such as `POST /api/auth/login/`. |
| **Model** | A Python class that describes a database table. |
| **Migration** | A file that changes the database structure to match the models. |
| **Serializer** | Turns model objects into JSON and checks incoming JSON (DRF). |
| **Idempotent** | Doing it twice has the same effect as doing it once. |
| **Constraint** | A rule the database itself enforces, even if the code has a bug. |
| **UTC** | The single world clock with no daylight saving. All instants are stored in UTC here. |
| **IANA timezone** | A name like `Asia/Kolkata` that knows that region's offset rules, including daylight saving. |
| **Task** | A function run in the background by Celery rather than during a web request. |

## Interview questions on this chapter

These are about how you approach the project, which interviewers often ask first.

1. **Q: Walk me through the project in one minute.**
   **A:** It is a Django REST backend for medication reminders. Patients add medicines with schedules written
   in their own local time. A background job turns schedules into concrete dose rows in UTC, another job emails
   a reminder at the right moment with a one-click "taken" link, and patients can mark doses taken or skipped.
   Caregivers and doctors can read an adherence report, but only for patients who invited them and who can
   revoke at any time. The hard parts were time zones with daylight saving, and guaranteeing a reminder is
   never silently lost.

2. **Q: What was the hardest part and how did you handle it?**
   **A:** Pick one and go deep. Good choices: (a) time zones, where schedules are stored as local clock times
   and converted to UTC only when generating doses, so 08:00 stays 08:00 across daylight saving changes; or
   (b) reliable reminders, using database constraints, row locking and idempotent tasks so a reminder is not
   sent twice. Say what the failure would have looked like if you had done the naive thing.

3. **Q: How did you verify the code works?**
   **A:** A pytest suite of 460 tests against a real PostgreSQL (including tests that use real threads to
   race two workers), coverage above 95% enforced in CI, and the suite runs on Python 3.12 and 3.13. I also
   ran specific scenarios by hand in the Django shell, for example the New York daylight saving day.

4. **Q: If you had one more week, what would you improve?**
   **A:** Name real limitations from the README's "Known limitations": no email verification or password
   reset, refresh tokens are not rotated or blacklisted, caregiver and doctor identities are not verified,
   and SMS/WhatsApp are stubs. Say which you would do first and why (for example, password reset and token
   rotation because they are security-relevant).

5. **Q: What do you not understand in your own project?**
   **A:** Be honest and specific, then show how you would find out. For example: "I have not run it against a
   real SMTP provider, only the console and in-memory backends, so I would test delivery and bounce handling
   there first." Honesty about limits, with a plan, reads as maturity.

6. **Q: Why did you write the schedule logic as small functions?**
   **A:** Pure functions such as `local_to_utc` and `dose_times` do not touch the database, so they are easy
   to test with exact examples (Kolkata, New York spring-forward, fall-back). The database-touching code
   (`generate_dose_events`, `sync_schedule_events`) is a thin layer on top.

7. **Q: How do you know the tests are not flaky?**
   **A:** I ran the full suite many times on both Python versions. When one CI run failed on Python 3.12 I
   did not retry and hope: I reproduced it, found that Celery's eager-mode guard is a process-wide flag that
   my threaded tests corrupted, and fixed the cause (`conftest.py`) with deterministic regression tests.

8. **Q: Where would you look first if a reminder was not sent?**
   **A:** The `NotificationLog` row for that dose: its status (`sending`, `sent`, `failed`, `cancelled`),
   `attempts`, `error` and `next_attempt_at`, then the structured logs (`reminder.claimed`,
   `reminder.sent`, `reminder.failed`), then whether the Beat and worker processes are running.

## Common mistakes to avoid

* **Reading without running.** You will forget it within a day. Run one command per section.
* **Memorising code instead of reasons.** Interviewers ask "why", not "what is on line 34".
* **Claiming features that are not there.** This backend has no email verification, no password reset and
  no real SMS. Say so confidently; it shows you understand your own system.
* **Skipping the first-principles parts** because they look easy. Most interview questions ("what is the
  difference between 401 and 403?", "why UTC?") are answered there.
* **Studying only the happy path.** For each feature, ask "what if two requests arrive at once?" and "what
  if the input is wrong?". This project is built around those questions.
* **Running experiments against data you care about.** Use the rolled-back transaction pattern above or the
  demo data from `seed_demo`.

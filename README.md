# Medication Reminder and Adherence Tracker

[![Tests](https://github.com/Ayush001Sharma/medication-reminder/actions/workflows/tests.yml/badge.svg)](https://github.com/Ayush001Sharma/medication-reminder/actions/workflows/tests.yml)

A backend (REST API plus background jobs) and a web frontend (in `frontend/`) for people who take medicine on a schedule.

- **Patients** add prescriptions with dose schedules, get an email reminder for every dose, and mark each dose
  taken or skipped, from the API or with one click from the email.
- **The system** generates doses in the patient's own timezone, sends each reminder **exactly once** (and
  catches up after downtime), marks untaken doses as missed, and emails a weekly summary.
- **Caregivers and doctors** can read a patient's adherence report **only after the patient invites them and they
  accept**. The patient can revoke access at any moment, and sees an audit log of every time their data was viewed.

Stack: Python 3.12+, Django 5.2, Django REST Framework, PostgreSQL, Celery + Redis (Celery Beat for scheduling),
JWT authentication (simplejwt), Swagger docs (drf-spectacular), pytest. The frontend is React 18, Vite, TypeScript, Tailwind CSS, React Router, Recharts and Vitest. No Docker.

> **Not a medical device.** This is a learning/demo-grade backend. It makes no HIPAA, GDPR or clinical-safety claims.
> See [Known limitations](#known-limitations) before using it with real patients.

## Contents

1. [Architecture](#architecture)
2. [How reminders avoid duplicates and misses](#how-reminders-avoid-duplicates-and-misses)
3. [How timezones are handled](#how-timezones-are-handled)
4. [Set up and run locally: macOS / Linux](#set-up-and-run-locally-macos--linux)
5. [Set up and run locally: Windows (PowerShell)](#set-up-and-run-locally-windows-powershell)
6. [Environment variables](#environment-variables)
7. [Demo data](#demo-data)
8. [Running the tests](#running-the-tests)
9. [API overview and examples](#api-overview-and-examples)
10. [Reports, access sharing, audit log, weekly summary](#reports-access-sharing-audit-log-weekly-summary)
11. [Database indexes](#database-indexes)
12. [Rate limiting and logging](#rate-limiting-and-logging)
13. [Continuous integration](#continuous-integration)
14. [Design decisions](#design-decisions)
15. [Known limitations](#known-limitations)
16. [Project layout](#project-layout)

## Architecture

```mermaid
flowchart LR
    client["API client<br/>(curl, mobile app, ...)"] -->|"HTTP + JWT"| api["Django + DRF API"]
    inbox[("Inboxes of patient,<br/>caregiver, doctor")] -->|"one-click link"| api
    api --> pg[("PostgreSQL<br/>source of truth")]
    api <-->|"rate-limit counters"| redis[("Redis")]
    beat["Celery Beat<br/>every minute / 5 min / hour / day"] -->|"enqueue tasks"| redis
    redis --> worker["Celery worker"]
    worker --> pg
    worker -->|"SMTP, or console in development"| mail["Email"]
    mail --> inbox
```

| Part | Responsibility |
|---|---|
| `accounts` | Custom user (email login, role patient / caregiver / doctor), patient profile with IANA timezone, JWT endpoints, access grants (invite, accept, revoke), rate limits on auth |
| `medications` | Prescriptions (medication) owned by one patient |
| `scheduling` | Schedules (local times, days of week), **dose events** (one row per dose, UTC), dose generation, taken/skip actions, the signed one-click link |
| `notifications` | The reminder pipeline: channel interface (email real; SMS and WhatsApp are log-only stubs), `NotificationLog`, claim/lease/retry/recovery, missed-dose job |
| `reports` | Adherence report, audit log, weekly summary emails |
| `config` | Settings, Celery app, health check, rate limiters, structured logging |

Beat jobs: `dispatch_reminders` every minute, `mark_missed_doses` every 5 minutes, `generate_upcoming_doses` daily
(00:10 UTC), `send_weekly_summaries` hourly (a patient's week ends at a different UTC time in each timezone).

Data model:

```mermaid
erDiagram
    USER ||--o| PATIENT_PROFILE : "patients have"
    USER ||--o{ MEDICATION : owns
    MEDICATION ||--o{ SCHEDULE : has
    SCHEDULE |o--o{ DOSE_EVENT : "generates (SET NULL on delete)"
    MEDICATION ||--o{ DOSE_EVENT : "history kept"
    USER ||--o{ DOSE_EVENT : "patient"
    DOSE_EVENT ||--o{ NOTIFICATION_LOG : "unique per channel"
    USER ||--o{ ACCESS_GRANT : "patient invites"
    USER ||--o{ AUDIT_LOG : "patient is viewed"
    USER ||--o{ WEEKLY_SUMMARY : "unique per week and recipient"
```

## How reminders avoid duplicates and misses

A reminder passes through one pipeline (`notifications/services.py`). The idea is **claim, then send, then record**:

```mermaid
sequenceDiagram
    participant B as Beat (every minute)
    participant W as Worker
    participant DB as PostgreSQL
    participant M as Mail server
    B->>W: dispatch_reminders
    W->>DB: BEGIN. SELECT due pending doses FOR UPDATE SKIP LOCKED
    W->>DB: mark reminded, INSERT NotificationLog(sending, lease token). COMMIT
    W->>W: queue deliver_notification(log, token)
    W->>DB: UPDATE log SET new token WHERE token = old (one caller can win)
    W->>M: send the email (no transaction or lock held)
    W->>DB: UPDATE log to sent, only while it still owns the lease
```

**Never twice.** Each layer covers a different failure:

| Failure | Defence |
|---|---|
| The same dose created twice | `UNIQUE (schedule, scheduled_at)` on dose events, and generation uses `bulk_create(ignore_conflicts=True)` |
| Two workers pick the same dose | `SELECT ... FOR UPDATE SKIP LOCKED`; the dose becomes `reminded` in the same transaction that inserts the log row |
| Two reminders for one dose and channel | `UNIQUE (dose_event, channel)` on `NotificationLog` |
| A task retried, redelivered by the broker, or run twice at once | Sending requires swapping a one-time **lease token** with one conditional `UPDATE`; only one caller can win it, everyone else sends nothing |
| Recovery racing the original sender | Recovery rotates the token, so the old task's token is dead |
| Overlapping Beat ticks | Same row locks and unique constraints; the second tick finds nothing to claim |

**Never missed.**

| Failure | Defence |
|---|---|
| Beat or the worker was down | Doses up to `REMINDER_GRACE_MINUTES` (default 60) late are still sent when it recovers |
| The mail server fails | Retried with exponential backoff (60 s, 120 s, 240 s, ...) up to `REMINDER_MAX_ATTEMPTS`, then recorded as `failed` with the error |
| A worker dies mid-send | The row stays `sending`; after `REMINDER_SENDING_TIMEOUT_SECONDS` recovery gives it a new lease and sends it |
| Doses not generated | Created when a schedule is saved, then topped up daily to 7 days ahead; the job is idempotent |
| A dose is ignored | After `DOSE_MISSED_AFTER_MINUTES` (default 120) it becomes `missed` (with `missed_at`), which feeds the reports |

**The exact guarantee is at-least-once.** A reminder is sent twice in exactly one narrow case: the mail server
accepted the message, and then the worker died before it recorded `sent`. Recovery then resends it (same
`Message-ID`, which many mail systems collapse). A reminder can also fail to arrive in the cases that are not
infrastructure bugs: workers down longer than the grace period, the mail provider failing for longer than all retries
(recorded as `failed`), or the patient having switched email off. For medication, a rare duplicate is far less
harmful than a silently lost reminder, so this is the deliberate trade-off.

## How timezones are handled

- **Everything stored is UTC.** Every `DateTimeField` holds UTC (`USE_TZ=True`, `TIME_ZONE="UTC"`).
- **Each patient has an IANA timezone** (for example `Asia/Kolkata`), validated with `zoneinfo` on registration and
  profile updates. Abbreviations such as `IST` and path tricks are rejected. The `tzdata` package is a dependency, so
  it works on Windows, which has no system timezone database.
- **A schedule stores local wall-clock times** (08:00 and 20:00), not UTC. They are converted to UTC only when doses
  are generated, with the patient's zone, so 08:00 stays 08:00 across daylight saving changes.
- **Daylight saving edge cases** (documented in `scheduling/services.py:local_to_utc`):
  a local time that does not exist (spring forward, 02:30 in New York) moves forward by the length of the gap to
  03:30; a local time that happens twice (fall back, 01:30) is scheduled once, at its first occurrence. Two times that
  collapse onto one instant produce one dose.
- **Local dates everywhere a person reads one.** A schedule's and medication's `end_date`, "today's doses", report
  ranges (`from`/`to`) and the weekly summary's Monday to Sunday are all dates in the patient's timezone. Ranges are
  turned into UTC between local midnights, so a 23- or 25-hour day is handled.
- **Changing a patient's timezone** moves their future pending doses to the new zone immediately; past doses keep
  their instants.

## Set up and run locally: macOS / Linux

You need Python 3.12 or newer, PostgreSQL 16 (Postgres.app, your package manager, or an installer from
postgresql.org) and a Redis URL: either a local Redis server (`redis://localhost:6379/0`) or a hosted one.

```bash
git clone https://github.com/Ayush001Sharma/medication-reminder.git
cd medication-reminder
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then edit .env (at least DATABASE_URL and REDIS_URL)
```

Create the database and a role. `CREATEDB` lets the tests create their own temporary database:

```bash
psql -d postgres -c "CREATE ROLE medreminder LOGIN CREATEDB PASSWORD 'choose-a-password'"
createdb -O medreminder medreminder
```

Put the matching URL in `.env`: `DATABASE_URL=postgres://medreminder:choose-a-password@localhost:5432/medreminder`.

```bash
python manage.py migrate
python scripts/check_redis.py       # confirms REDIS_URL works
python manage.py seed_demo          # optional: demo patients, doctor, caregiver, a week of history
```

Run the three processes, each in its own terminal with the virtualenv activated:

```bash
python manage.py runserver
```
```bash
celery -A config worker -l info
```
```bash
celery -A config beat -l info
```

Check it: `curl localhost:8000/health/` returns `{"status": "OK", "database": "ok", "redis": "ok"}`, and
http://localhost:8000/api/docs/ is the interactive Swagger UI. In development, emails are **printed in the worker's
terminal** (console backend).

> **Cloud development container only.** `scripts/dev_services.sh` installs and starts PostgreSQL and Redis inside
> this project's Linux cloud sandbox and creates a database role `medreminder` with the password `medreminder` (not a
> superuser: `LOGIN` and `CREATEDB` only). **That role, its password, and the demo-account password are for local
> development only. Never reuse them anywhere reachable from a network.** Nothing in the project requires a bash
> script to run; the commands above are the whole procedure.

## Set up and run locally: Windows (PowerShell)

Everything below uses PowerShell and Python only; no bash, no Docker. Open **PowerShell** (the blue window; Windows
PowerShell 5.1 and PowerShell 7 both work).

> **Honesty note.** These steps were walked through command by command and the platform-specific parts were checked
> (no Unix-only code; the app was run under `--pool=solo`; `.env` encoding cases were tested), but they were **not
> executed on a Windows machine**. The "Things that go wrong on Windows" list below is where to look first if a step
> fails.

**1. Install the prerequisites**

- Python 3.12 or newer from python.org. Tick **Add python.exe to PATH**. Check with `python --version`.
- Git for Windows.
- PostgreSQL 16 from the EDB installer (postgresql.org/download/windows). Remember the password you give the `postgres`
  user and keep port 5432.
- A hosted Redis (for example Upstash). Copy its **TLS connection URL**; it looks like
  `rediss://default:<password>@<host>:6379`. Redis does not run natively on Windows, which is why a hosted one is used.

**2. Get the code and create a virtual environment**

```powershell
git clone https://github.com/Ayush001Sharma/medication-reminder.git
cd medication-reminder
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

If activation fails with "running scripts is disabled on this system", allow scripts for this window only, then
activate again: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`. (Or skip activation and call
`.\.venv\Scripts\python.exe` and `.\.venv\Scripts\celery.exe` directly.)

**3. Create the database and a role**

`psql` is not on the PATH after installing PostgreSQL, so call it by its folder (adjust `16` to your version):

```powershell
$pg = "C:\Program Files\PostgreSQL\16\bin"
& "$pg\psql.exe" -U postgres -c "CREATE ROLE medreminder LOGIN CREATEDB PASSWORD 'choose-a-password';"
& "$pg\createdb.exe" -U postgres -O medreminder medreminder
```

Each command asks for the `postgres` password. Pick a password without `$`, backticks or quotes. `CREATEDB` is needed so
the tests can create their temporary database.

**4. Create `.env`**

```powershell
Copy-Item .env.example .env
notepad .env
```

Set at least these two lines and save (keep the encoding UTF-8):

```
DATABASE_URL=postgres://medreminder:choose-a-password@localhost:5432/medreminder
REDIS_URL=rediss://default:YOUR-REDIS-PASSWORD@YOUR-HOST.upstash.io:6379
```

Characters such as `@`, `:` or `/` inside a password must be URL-encoded (`@` becomes `%40`). A `rediss://` URL
without `ssl_cert_reqs` automatically gets `?ssl_cert_reqs=required` so the server certificate is verified.
Recommended for readable consoles: `$env:PYTHONUTF8 = "1"`.

**5. Create the tables and check Redis**

```powershell
python manage.py migrate
python scripts\check_redis.py
python manage.py seed_demo
```

`seed_demo` is optional (demo accounts and a week of history).

**6. Run the three processes in three separate PowerShell windows.** In each: `cd` into the project and run
`.\.venv\Scripts\Activate.ps1` first.

```powershell
python manage.py runserver
```
```powershell
celery -A config worker -l info --pool=solo
```
```powershell
celery -A config beat -l info
```

The worker **must** use `--pool=solo`: Celery's default `prefork` pool does not work on Windows. Do not use
`celery worker -B` on Windows either; run Beat as its own process as above.

**7. Check it**

```powershell
Invoke-RestMethod http://localhost:8000/health/
```

You should see `status OK`, `database ok`, `redis ok`. Open http://localhost:8000/api/docs/ in a browser. Reminder emails
are printed in the worker window.

**Things that go wrong on Windows**

| Symptom or fact | Cause and fix |
|---|---|
| `Activate.ps1 cannot be loaded because running scripts is disabled` | Execution policy. `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` for this window only. |
| `psql` / `createdb` is "not recognized" | PostgreSQL's `bin` folder is not on the PATH. Use the full path as in step 3. |
| The worker starts but tasks never run, or it raises errors such as `ValueError: not enough values to unpack` (a commonly reported symptom; not reproducible on the Linux machine used for testing) | You used Celery's default `prefork` pool, which does not work on Windows. Add `--pool=solo`. |
| **`--pool=solo` cannot enforce task time limits** | The hard kill (60 s by default) that bounds a stuck email send does not exist on this pool, so a send blocked inside the mail server is not killed (only `EMAIL_TIMEOUT` limits each network wait). Fine for development; run workers on Linux for production. |
| `solo` runs one task at a time | A slow email delays the next reminder. Fine for development. |
| `UnicodeDecodeError` when starting, or a message saying `.env is not a UTF-8 text file` | Windows PowerShell 5.1 writes **UTF-16** when you create a file with `>` or `echo`. Recreate it with `Copy-Item .env.example .env` and edit it in an editor. (UTF-8 with a BOM and CRLF line endings are fine.) |
| `curl` behaves strangely | In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. Use `Invoke-RestMethod` (examples below) or `curl.exe`. |
| `password authentication failed` or a URL error | Special characters in the database password must be URL-encoded in `DATABASE_URL`. |
| `could not connect to server` | The PostgreSQL service is not running: `Get-Service postgresql*`, then `Start-Service <name>`. |
| Garbled characters or `UnicodeEncodeError` in the worker window | `$env:PYTHONUTF8 = "1"` before starting. |
| Redis connection errors with a hosted Redis | Use the `rediss://` (TLS) URL with the password, and check your provider's plan limits: Celery polls Redis continuously and Beat runs every minute, which counts against per-command quotas on some free tiers. |
| `scripts/dev_services.sh` | A Linux-only helper for the cloud sandbox. You never need it. |

## Environment variables

Settings come from real environment variables, or from a `.env` file in the project root (copy `.env.example`).
Real variables win over `.env`. **`.env` is git-ignored; never commit it. `.env.example` holds placeholders only.**
Bad values stop the app at startup with a message naming the variable.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | **yes** | none | PostgreSQL connection URL, `postgres://USER:PASSWORD@HOST:5432/NAME` |
| `REDIS_URL` | **yes** | none | Redis URL for the Celery broker and result backend, and rate-limit counters. `redis://` or TLS `rediss://` (ssl_cert_reqs=required is added if missing) |
| `DJANGO_SECRET_KEY` | when `DJANGO_DEBUG` is not true | built-in dev key | Signs JWTs and one-click dose links. Must be 32+ random characters outside debug mode (the app refuses to start otherwise). Generate: `python -c "import secrets; print(secrets.token_urlsafe(50))"` |
| `DJANGO_DEBUG` | no | `true` | `true` for local development only. Set `false` anywhere other people can reach |
| `DJANGO_ALLOWED_HOSTS` | no | `localhost,127.0.0.1` | Comma-separated host names the server answers to |
| `SITE_BASE_URL` | no | `http://localhost:8000` | Public address used to build the one-click link in reminder emails |
| `CORS_ALLOWED_ORIGINS` | no | empty (no cross-origin access) | Comma-separated browser origins (the web frontend) allowed to call `/api/`, e.g. `http://localhost:5173,https://app.example.com`. Scheme and host (and optional port) only: no path, no wildcard. A bad value stops startup. Only `/api/` is exposed; credentials/cookies are never allowed (auth is a bearer token); `Retry-After` is exposed so the frontend can read rate-limit waits |
| `EMAIL_BACKEND` | no | console backend | Where emails go. Default prints them in the worker terminal. For real mail: `django.core.mail.backends.smtp.EmailBackend` |
| `DEFAULT_FROM_EMAIL` | no | `reminders@medreminder.local` | The From address on every email |
| `EMAIL_TIMEOUT` | no | `30` | Seconds one SMTP network operation may take |
| `EMAIL_HOST` | no | `localhost` | SMTP server host (SMTP backend only) |
| `EMAIL_PORT` | no | `587` | SMTP server port |
| `EMAIL_USE_TLS` | no | `true` | Use STARTTLS |
| `EMAIL_HOST_USER` | no | empty | SMTP username |
| `EMAIL_HOST_PASSWORD` | no | empty | SMTP password. **Secret: set it in the environment, never in a committed file** |
| `NOTIFICATION_CHANNELS` | no | `email` | Comma-separated channels in use: `email`, `sms`, `whatsapp` (the last two are log-only stubs) |
| `REMINDER_LEAD_SECONDS` | no | `60` | Send a reminder this long before the dose time |
| `REMINDER_GRACE_MINUTES` | no | `60` | A dose is still reminded up to this late (catch-up after downtime). Must be below `DOSE_MISSED_AFTER_MINUTES` |
| `REMINDER_SENDING_TIMEOUT_SECONDS` | no | `600` | A reminder stuck in "sending" this long is recovered. Must be at least 2 x (`EMAIL_TIMEOUT` + 30) |
| `REMINDER_MAX_ATTEMPTS` | no | `5` | Send attempts before a reminder is recorded as failed |
| `REMINDER_RETRY_BASE_SECONDS` | no | `60` | Delay before the first retry; doubles each time |
| `REMINDER_BATCH_SIZE` | no | `200` | Most reminders claimed in one Beat tick |
| `DOSE_MISSED_AFTER_MINUTES` | no | `120` | A dose still untaken this long after its time becomes `missed` |
| `WEEKLY_SUMMARY_LOCAL_HOUR` | no | `8` | Local hour (0-23) on Monday from which each patient's finished week is emailed |
| `RATE_LIMIT_LOGIN` | no | `10/min` | Login attempts per client address |
| `RATE_LIMIT_LOGIN_ACCOUNT` | no | `5/min` | Login attempts per account (email) |
| `RATE_LIMIT_REGISTER` | no | `20/hour` | Registrations per client address |
| `RATE_LIMIT_INVITE` | no | `20/hour` | Access invitations per patient |
| `RATE_LIMIT_DOSE_LINK` | no | `30/min` | One-click link requests per client address |
| `NUM_PROXIES` | no | `0` | Reverse proxies in front of the app. `0` trusts only the socket address; a wrong value lets clients fake their address and dodge rate limits |
| `LOG_FORMAT` | no | `plain` | `plain` (readable) or `json` (one JSON object per line) |
| `LOG_LEVEL` | no | `INFO` | Standard Python log level |
| `DEMO_PASSWORD` | no | documented default | Password for the `seed_demo` accounts (local development only) |

Rates are written `<count>/<sec|min|hour|day>`.

## Demo data

```bash
python manage.py seed_demo            # create (does nothing if it already exists)
python manage.py seed_demo --reset    # delete the demo users and rebuild
```

It creates, deterministically and for **local development only**: Asha (patient, `Asia/Kolkata`, three medications,
high adherence of roughly 95% and a long unbroken streak), Ben (patient, `America/New_York`, two medications, low
adherence of roughly 55%, last dose missed so a streak of 0), a caregiver (Carla) and a doctor (Dr. Rao). A week of dose history, notification logs, the next 7 days of
doses, accepted grants, one **pending** invitation (Ben to Carla, so you can try accepting it), and two audit entries.

| Account | Role | Email |
|---|---|---|
| Asha | patient | `demo.asha@example.com` |
| Ben | patient | `demo.ben@example.com` |
| Carla | caregiver | `demo.carla@example.com` |
| Dr. Rao | doctor | `demo.dr.rao@example.com` |

All four share one password: the `--password` option, else `DEMO_PASSWORD`, else the default **`demo-password-123`**.
The command refuses to run unless `DJANGO_DEBUG=true` (use `--force` to override), because these accounts are
public knowledge. Never seed a real deployment.

## Running the tests

Tests need PostgreSQL (the role from `DATABASE_URL` must be allowed to create databases). Redis is needed only for
one integration test, which skips itself when Redis is unreachable. Rate-limit counters use an in-memory cache in
tests.

```bash
pytest                                  # everything
pytest -k reminder                      # by name
pytest --cov --cov-report=term-missing  # with coverage (line and branch)
```

```powershell
pytest
pytest --cov --cov-report=term-missing
```

What the suite covers: every endpoint and permission, the dose-generation and DST rules, the reminder pipeline
(**including concurrency tests that use real threads against real PostgreSQL**, not mocks), the adherence
definition, access sharing, audit logging, weekly summaries, rate limits, structured logging, index usage, the seed
command, configuration validation (bad settings are started in a subprocess and must fail with a clear message), and a
test that fails if an environment variable is read by the code but missing from `.env.example` or this README.
Coverage is above 95% and CI enforces that floor.

## API overview and examples

Interactive documentation: **http://localhost:8000/api/docs/** (schema at `/api/schema/`). Protected endpoints take
`Authorization: Bearer <access token>`.

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register/`, `POST /api/auth/login/`, `POST /api/auth/refresh/`, `GET/PATCH /api/me/` |
| Medications (patients) | `GET/POST /api/medications/`, `GET/PATCH /api/medications/{id}/`, `POST /api/medications/{id}/deactivate/` |
| Schedules (patients) | `GET/POST /api/medications/{id}/schedules/`, `GET/PATCH/DELETE /api/medications/{id}/schedules/{sid}/` |
| Doses (patients) | `GET /api/doses/today/`, `GET /api/doses/upcoming/?days=7`, `POST /api/doses/{id}/taken/`, `POST /api/doses/{id}/skip/` |
| One-click email link | `GET /dose/taken/<token>/` (read-only confirmation page), `POST` the same URL (marks taken) |
| Access sharing | patient: `GET/POST /api/access/grants/`, `POST /api/access/grants/{id}/revoke/`. Caregiver/doctor: `GET /api/access/invitations/`, `POST /api/access/invitations/{id}/accept/`, `GET /api/patients/` |
| Reports | `GET /api/reports/adherence/?patient=&from=&to=`, `GET /api/audit-log/` (patient) |
| Operations | `GET /health/` (database and Redis), `/api/docs/`, `/api/schema/` |

### With curl (macOS / Linux)

```bash
BASE=http://localhost:8000

# Register a patient (timezone is required) and log in
curl -s -X POST $BASE/api/auth/register/ -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-password-123","role":"patient","timezone":"Asia/Kolkata"}'
TOKEN=$(curl -s -X POST $BASE/api/auth/login/ -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-password-123"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['access'])")

# A medication, then a schedule at 08:00 and 20:00 every day (local time)
curl -s -X POST $BASE/api/medications/ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Metformin","dosage":"500 mg","instructions":"With food","start_date":"2030-01-01"}'
curl -s -X POST $BASE/api/medications/1/schedules/ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"times_of_day":["08:00","20:00"],"start_date":"2030-01-01"}'

# Today's doses, then mark one taken (repeating it is safe)
curl -s $BASE/api/doses/today/ -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/api/doses/1/taken/ -H "Authorization: Bearer $TOKEN"

# Invite a caregiver (the answer is the same whether or not the account exists)
curl -s -X POST $BASE/api/access/grants/ -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"carla@example.com"}'

# As the caregiver: see the invitation, accept it, read the report
curl -s $BASE/api/access/invitations/ -H "Authorization: Bearer $CARER_TOKEN"
curl -s -X POST $BASE/api/access/invitations/1/accept/ -H "Authorization: Bearer $CARER_TOKEN"
curl -s "$BASE/api/reports/adherence/?patient=1&from=2030-01-01&to=2030-01-31" -H "Authorization: Bearer $CARER_TOKEN"

# As the patient: who looked at my data? Then revoke.
curl -s $BASE/api/audit-log/ -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/api/access/grants/1/revoke/ -H "Authorization: Bearer $TOKEN"
```

### With PowerShell (Windows)

```powershell
$base = "http://localhost:8000"
$json = "application/json"

# Register a patient and log in
Invoke-RestMethod "$base/api/auth/register/" -Method Post -ContentType $json -Body (@{
    email = "me@example.com"; password = "a-long-password-123"; role = "patient"; timezone = "Asia/Kolkata" } | ConvertTo-Json)
$token = (Invoke-RestMethod "$base/api/auth/login/" -Method Post -ContentType $json -Body (@{
    email = "me@example.com"; password = "a-long-password-123" } | ConvertTo-Json)).access
$auth = @{ Authorization = "Bearer $token" }

# A medication and a schedule
Invoke-RestMethod "$base/api/medications/" -Method Post -Headers $auth -ContentType $json -Body (@{
    name = "Metformin"; dosage = "500 mg"; instructions = "With food"; start_date = "2030-01-01" } | ConvertTo-Json)
Invoke-RestMethod "$base/api/medications/1/schedules/" -Method Post -Headers $auth -ContentType $json -Body (@{
    times_of_day = @("08:00", "20:00"); start_date = "2030-01-01" } | ConvertTo-Json)

# Today's doses, then mark one taken
Invoke-RestMethod "$base/api/doses/today/" -Headers $auth
Invoke-RestMethod "$base/api/doses/1/taken/" -Method Post -Headers $auth

# Invite a caregiver, then (as the caregiver, with $carerAuth) read the report
Invoke-RestMethod "$base/api/access/grants/" -Method Post -Headers $auth -ContentType $json -Body (@{ email = "carla@example.com" } | ConvertTo-Json)
Invoke-RestMethod "$base/api/reports/adherence/?patient=1&from=2030-01-01&to=2030-01-31" -Headers $carerAuth
```

A request that is rate limited answers `429` with a `Retry-After` header.

## Reports, access sharing, audit log, weekly summary

**Access sharing.** A patient invites a caregiver or doctor **by email**. The invitation is stored against the address,
so the invite call returns the **same answer whether or not an account exists** (the API cannot be used to find out
which emails are registered), and a pending grant looks identical either way. Only a caregiver or doctor account with
that exact email can accept; the grant then becomes `active`. A partial unique constraint allows only one pending or
active grant per patient and email, even under simultaneous requests. Revoked grants are kept as history and the same
person can be invited again. Every request checks the grant **in the database**: nothing is cached and grants are not
stored in the token, so **revoking takes effect on the very next request**. Without an active grant the answer is
`404`, identical to "no such patient".

**Adherence definition** (also in `reports/services.py` and returned in every report):

- Only doses that are **due** (`scheduled_at <= now`) and **resolved** are counted. `pending`, `reminded` and future
  doses are never counted.
- `adherence % = taken / (taken + missed) x 100`, one decimal, `null` when there is nothing to divide.
- A dose taken after it was already missed counts as **taken** and is also reported as `taken_late`.
- **Skipped** doses are reported separately and are **not** in the percentage. `total = taken + missed + skipped`.
- A per-medication breakdown has the same fields. `current_streak` is the number of consecutive taken doses ending now;
  a missed dose ends it; skipped and unresolved doses are ignored.
- `from` and `to` are the patient's **local** dates, inclusive; the default is the last 30 days; the maximum is **366
  days**. The report uses four aggregate queries, however many doses exist.

**Audit log.** Every time a caregiver or doctor views a patient's report, a row records who (email and role, copied so
the entry survives account deletion), which patient, the date range and when. It is written **before** data is
returned, and if the write fails no data is returned. Weekly summaries emailed to a caregiver or doctor are logged
too. Patients read their own log at `GET /api/audit-log/`. A patient viewing their own report is not logged.

**Weekly summary.** Hourly, each patient whose local week (Monday to Sunday) has ended gets it emailed (from
`WEEKLY_SUMMARY_LOCAL_HOUR` on Monday) together with every caregiver or doctor with an **active** grant at that moment.
One `WeeklySummary` row, **unique per patient, week and recipient**, is inserted before sending, so running the job
twice, or two overlapping runs, cannot send a duplicate. Failed sends are retried on later runs (3 attempts).

## Database indexes

Measured with `EXPLAIN (ANALYZE, BUFFERS)` on a scratch PostgreSQL 16 database with **1,000,000 doses** (1,000
patients) and **300,000 notification logs**, running the project's real ORM queries, before and after the indexes in
`scheduling/migrations/0005_query_indexes.py` and `notifications/migrations/0002_query_indexes.py`:

| Hot query | Before | After | Why |
|---|---|---|---|
| **Claim due doses** (every minute) | 9.8 ms, 3,028 buffers; probed the patient index once **per patient** (`loops=1000`), so it grows with the number of patients | **0.17 ms, 5 buffers**; one read of a 224 kB index | Partial index `dose_open_idx (scheduled_at) WHERE status IN ('pending','reminded')` holds only upcoming doses, so the planner starts from the few due rows |
| Mark overdue doses missed (every 5 min) | 0.10 ms | 0.06 ms | Same partial index (224 kB instead of the 9.9 MB full-status index) |
| Adherence report, 90 days | 1.43 ms, 278 buffers (bitmap heap scan) | **0.35 ms, 32 buffers** (index-only scan) | Covering index `dose_patient_cover_idx (patient, scheduled_at) INCLUDE (status, medication, taken_late)` answers the aggregate without touching the table |
| Adherence report, 366 days (max) | 4.04 ms, 980 buffers | **0.79 ms, 94 buffers** (index-only scan) | Same |
| Streak: latest missed dose, patient who never misses | 0.92 ms, 1,075 buffers (walks the whole history) | **0.10 ms**, constant | Partial index `dose_patient_missed_idx (patient, scheduled_at) WHERE status = 'missed'` |
| Today's doses; streak for patients who miss | about 0.05 ms | about the same | Already fast; no regression |
| Retry / stuck-send scan (every minute) | 0.76 ms; 2.4 MB index | 0.70 ms; **16 kB** index | Partial index `notif_sending_idx (next_attempt_at) WHERE status = 'sending'`: no faster, but it no longer holds every finished row and finishing a send removes its entry |

Plan for the claim query, before and after (trimmed):

```
BEFORE  Hash Right Join ... Seq Scan on accounts_patientprofile ... Seq Scan on accounts_user
          -> Index Scan using dose_patient_time_idx on scheduling_doseevent  (rows=0, loops=1000)
        Execution Time: 9.822 ms

AFTER   Hash Join (patient_id = accounts_user.id)
          -> Index Scan using dose_open_idx on scheduling_doseevent   (rows=0, loops=1)
          -> Hash ... (never executed)
        Execution Time: 0.169 ms
```

Report query (366 days): `Bitmap Heap Scan ... 4.0 ms` became `Index Only Scan using dose_patient_cover_idx ... 0.79 ms`.
The report counts the `status` column rather than the primary key on purpose: `COUNT(id)` would need the table and
lose the index-only scan (a test guards this). Costs: the covering index is about 40% larger than the one it replaced
(56 MB against 40 MB at 1M rows), so inserts do slightly more work. The migrations build indexes **concurrently** and
create the new indexes before dropping the old ones, so a large table is not locked. `tests/test_indexes.py` checks the
indexes exist and that the planner can still use each one for the real query. On a tiny table PostgreSQL may still
choose a sequential scan; the plans above matter at scale.

## Rate limiting and logging

**Rate limits** (`config/ratelimit.py`, counters in Redis so they hold across processes). Defaults: login 10/min per
address and 5/min per account; registration 20/hour per address; access invitations 20/hour per patient; the one-click
link 30/min per address. Over the limit: `429` with `Retry-After` (an HTML page for the link). Counter keys hold a hash
of the email, never the address itself. If Redis is down the limiter **fails open** (requests are allowed and an error
is logged) so a cache outage does not become a login outage. Behind a reverse proxy set `NUM_PROXIES`.

**Structured logging** (`config/logging_utils.py`). Pipeline events are one line each, named and with fields, for
example:

```json
{"ts":"2026-11-24T19:41:00.112+00:00","level":"INFO","logger":"notifications.services","event":"reminder.sent","log_id":41,"dose_id":115,"channel":"email","attempt":1,"send_ms":10,"lateness_s":-12}
```

Events: `reminder.claimed`, `reminder.dispatch`, `reminder.sent`, `reminder.retry_scheduled` (WARNING),
`reminder.failed` (ERROR), `reminder.recovered` (WARNING), `reminder.cancelled`, `reminder.skipped`,
`reminder.lease_lost_after_send` (WARNING), `dose.marked_missed` (WARNING), `ratelimit.cache_unavailable` (ERROR).
`lateness_s` is how late the reminder was relative to the dose time (negative means early). **Logs carry ids and counts
only**: never emails, phone numbers, medication names, tokens or exception messages (a test checks this). Set
`LOG_FORMAT=json` for log tools.

## Continuous integration

`.github/workflows/tests.yml` runs on every push and pull request, on Python 3.12 and 3.13. It starts **PostgreSQL 16
and Redis 7 as service containers**, installs the pinned requirements, then runs `manage.py check`, verifies that no
migration is missing, validates the OpenAPI schema with no warnings, and runs the whole test suite with coverage
(failing below 95%). The database password in the workflow exists only inside that throwaway job. (CI uses containers
on GitHub's machines; running the project locally does not use Docker.)

## Design decisions

**Delivery guarantee: at-least-once, claim then send.** Doses are claimed in a short transaction (`SKIP LOCKED`, status
flipped, unique log row, lease token), the email is sent outside any transaction, and the outcome is recorded only by
whoever still holds the lease. I chose at-least-once over at-most-once because losing a medication reminder is worse
than a rare duplicate. The one duplicate window is: mail server accepted the message, worker died before recording
`sent`. Weekly summaries make the opposite choice (at-most-once) because they are digests, not safety-critical.

**Adherence = taken / (taken + missed).** Late doses count as taken (and are reported as late), skipped doses are
reported but excluded because skipping is a decision (often with a doctor's advice) rather than a failure, and pending,
reminded and future doses are not counted because their outcome is unknown. Reports and the streak are computed in the
database, not in Python.

**Timezones and daylight saving.** UTC in the database; the patient's IANA zone and local wall-clock schedules; the
conversion happens at generation time. Nonexistent local times shift forward by the gap, ambiguous ones use the first
occurrence, and both produce exactly one dose. All user-visible dates (end dates, "today", report ranges, weekly
boundaries) are local dates.

**Access model.** Consent belongs to the patient: invite by email, explicit acceptance, revocation at any time.
Roles are enforced on every endpoint; a caregiver or doctor can reach a patient only through an active grant that is
checked in the database on every request (no caching, nothing in the JWT). "No access" and "no such patient" are the
same `404`, and inviting does not reveal which emails have accounts. Third-party views are audited and the patient can
read the log.

**Other choices.** Medications are deactivated, never deleted, so history survives; deleting a schedule keeps its dose
history (`SET NULL`). The one-click email link opens a page and only its `POST` changes anything, because mail scanners
prefetch links. Settings fail loudly at startup rather than running misconfigured.

## Known limitations

- **No invitation email.** An invited caregiver or doctor has to be told out of band; they then see the invitation
  under `GET /api/access/invitations/`.
- **Authentication is minimal.** No email verification, password reset or account deletion endpoint; refresh tokens are
  not rotated or blacklisted, so a stolen refresh token works until it expires (7 days); caregiver and doctor identities
  are **not verified** (anyone can register as one, though they can see nothing without a patient's invitation).
- **Only email is real.** SMS and WhatsApp are log-only stubs. SMTP delivery is configured but has only been exercised
  against the console backend and the in-memory test backend, not a real provider.
- **Rate limiting is approximate** (a few extra requests can slip through under heavy concurrency), fails open when Redis
  is down, and the per-account login limit can be used to annoy a specific user by locking their login for a minute.
- **Windows workers** use `--pool=solo`: one task at a time and no hard time limit on a stuck send. Use Linux for
  production workers.
- **Caregivers and doctors can read reports only**, not medication or dose lists. Reminders go to the patient only.
- **Timezone changes affect future doses only.** Time of day is a wall-clock time; there is no per-dose manual time.
- **Dose actions cannot be undone**, and a missed dose cannot be skipped later.
- **No production deployment setup**: no WSGI server configuration, static files, TLS termination or secrets manager.
  No pagination on dose lists (they are naturally small), no API versioning.
- **No privacy tooling** (data export, retention policy, encryption at rest beyond what your database provides), and no
  clinical validation. Do not treat reminders as the only safeguard for critical medication.
- **Clock dependence.** Reminder timing relies on the server clocks of the database and workers being correct.

## Web frontend

The `frontend/` folder is a single-page app: React 18, Vite, TypeScript, Tailwind CSS 4, React Router, Recharts, tested with
Vitest and React Testing Library. Fonts (DM Sans for text, Fraunces for headings) are self-hosted from `@fontsource`
packages: nothing is loaded from a CDN. It has the app shell, authentication, role-based routing, the component library and
the **patient screens** (below). A caregiver/doctor's *Patients* page exists; *Sharing*, *Activity* and *Invitations* are
routed placeholders waiting to be built.

**Patient screens.**

| Screen | What it does |
|---|---|
| Register / Sign in | Registration asks for a timezone, defaulting to the browser's (`Intl.DateTimeFormat().resolvedOptions().timeZone`), in a searchable select of IANA zones (type a city, country or GMT offset; old names such as "Calcutta" also match). API field errors, such as an invalid timezone, appear under the field |
| Today | Today's doses in the patient's local time, grouped Morning / Afternoon / Evening / Night, each with medication, dosage, local time and a status chip (Pending, Reminded, Taken, Missed, Skipped, Taken late). **Taken** and **Skip** update the screen at once and roll back with a "Try again" toast if the server refuses. A `409` (for example skipping a dose that was already taken) shows a plain-language message and refreshes the list without a loading flash. Calm empty state when nothing is scheduled |
| Upcoming | The next 7 days of doses, grouped by day |
| Medications | Medications with their schedules; **Add medication** (name, dosage, dates, time chips, day-of-week toggles), **Edit**, and **Stop** (deactivate) behind a confirmation dialog. API validation errors are shown on the matching field |

Every page has a loading skeleton, an error state with a retry button, and a responsive layout (bottom tab bar on phones, top
navigation on wider screens).

**Run it (macOS / Linux).** Needs Node.js 22 or newer and the backend running.

```bash
cd frontend
cp .env.example .env.local       # VITE_API_BASE_URL=http://localhost:8000
npm ci
npm run dev                      # http://localhost:5173
```

**Run it (Windows PowerShell).** Install Node.js 22 LTS from nodejs.org first.

```powershell
cd frontend
Copy-Item .env.example .env.local
npm ci
npm run dev
```

The browser may only call the API from an origin the backend allows. In the backend's `.env` set
`CORS_ALLOWED_ORIGINS=http://localhost:5173` (the dev server; add `http://localhost:4173` for `npm run preview`), then restart
Django. With the demo data (`python manage.py seed_demo`) you can sign in as `demo.asha@example.com` (patient) or
`demo.dr.rao@example.com` (doctor) with the demo password.

| Command (in `frontend/`) | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run lint` | ESLint (TypeScript, React hooks rules), zero warnings allowed |
| `npm run typecheck` | `tsc --noEmit`, strict mode |
| `npm test` | Vitest (`npm run test:watch` while developing) |
| `npm run build` | Type-check, then a production build in `dist/` |
| `npm run preview` | Serve the production build on port 4173 |

| Frontend variable | What it does |
|---|---|
| `VITE_API_BASE_URL` | Base URL of the backend, no trailing slash (default in `.env.example`: `http://localhost:8000`). Read at **build** time and visible to anyone who opens the site: never put a secret in a `VITE_` variable. |

**Authentication.** `src/api/client.ts` attaches the JWT access token to every request. On a `401` it exchanges the refresh
token for a new access token **once**, then retries the request; several requests that fail together share one refresh. If
the refresh fails (or the retried request is refused again) the session is ended and the user lands on the sign-in page with
a notice. Sign-in, registration and the refresh call itself never trigger a refresh. Tokens live **in memory and in
`sessionStorage`, never `localStorage`**: they survive a page reload but not closing the tab. `sessionStorage` is still
readable by any script on the page, so the real protection is not rendering untrusted HTML (the app renders none).
`ProtectedRoute` guards routes by role: signed-out visitors go to `/login` (and come back afterwards); the wrong role sees a
"not available" page. This only controls what the UI shows; the backend enforces access on every request.

**Design system.** The palette lives in one place, `src/index.css`, as Tailwind theme tokens (`cream`, `surface`, `subtle`,
`sage`, `sage-dark`, `sage-tint`, `ink`, `muted`, `line`, `clay`, `danger`). Tailwind's default palette is removed, so a class
like `bg-blue-500` does not exist, and a test fails if one appears. Components: `Button`, `Card`, `Input`, `Select`, `Badge`
(status chips), `Modal` (focus trap, Escape, focus return), `Toast`, `Skeleton`, `EmptyState`. Rounded-2xl cards, soft shadows,
150-200 ms transitions, a 3 px keyboard focus ring and large (48 px) buttons; motion is switched off for people who ask for
reduced motion.

**Contrast (WCAG AA) and the rules it forces.** Measured from the tokens (and checked by `src/theme/theme.test.ts` and by axe
in a real browser): body ink on cream is 12.7:1. Some of the specified pairs do **not** reach AA for normal text, so the
components avoid them:

| Pair | Ratio | Consequence |
|---|---|---|
| white on sage `#6B8F71` | 3.63 | Filled buttons use `sage-dark` (6.0:1 with white text), not `sage`. Sage is used for borders (3.6:1, enough for control edges), the logo, charts and accents |
| `muted` on cream / subtle | 4.44 / 4.13 | `muted` text appears only on white surfaces (cards, inputs, menus). A test lists the allowed files |
| `clay` as text | 2.84 | Clay is only a fill, always with ink text (4.8:1) |
| the `line` border on cream | 1.22 | Used for decoration only; form controls use the sage border |

Status chips always carry a word ("Missed", "Taken late"), never colour alone.

**Tests** (`npm test`): the API client (refresh-once, single-flight, logout on every refresh-failure path, no refresh for
sign-in calls, error messages, `VITE_API_BASE_URL`), the token store (never `localStorage`), route protection for every role,
the auth provider, the shell and navigation per role, every component, each page's loading / empty / error states, the Today page's actions
(optimistic update, rollback, 409, double-click guard), the medication form's validation, the design
tokens, and an axe-core accessibility audit of the shell, forms, dialog and pages. Contrast is not testable in jsdom, so it is
verified from the tokens and in a real browser.

**CI.** The `frontend` job in `.github/workflows/tests.yml` runs `npm ci`, lint, type-check, tests and build on every push.

**Frontend limitations.** Sharing, the audit log, invitations and the per-patient report view are not built yet; the API for
all of them exists. **There is no real undo** for a dose: the API treats taken and skipped as final (a taken dose cannot be
skipped, and nothing reverses it), so instead of a fake undo the app rolls back and offers "Try again" when a request fails.
A stopped medication cannot be reactivated (the API has no such action); add it again as a new medication. There is no
server-side sign-out (the backend has no token blacklist), so signing out forgets the tokens in the browser only. The
production build is not deployed anywhere.

## Project layout

```
config/          settings, Celery app, health check, rate limiters, structured logging, env helpers
accounts/        users, patient profile, JWT, access grants, seed_demo command
medications/     medication model and API
scheduling/      schedules, dose events, generation, dose actions, one-click link
notifications/   channels, reminder pipeline, notification log, missed-dose job
reports/         adherence report, audit log, weekly summaries
frontend/        React web app (see Web frontend)
tests/           cross-cutting tests (configuration, rate limits, health, indexes, CORS)
scripts/         check_redis.py (any OS); dev_services.sh (Linux cloud sandbox only)
.github/workflows/tests.yml
```

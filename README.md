# Medication Reminder and Adherence Tracker

Django 5.2 + DRF backend. Celery + Redis for scheduling, PostgreSQL for data. No Docker. See `CLAUDE.md` for the full brief.

Apps: `accounts`, `medications`, `scheduling`, `notifications`, `reports`.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then edit DATABASE_URL and REDIS_URL
```

Both `DATABASE_URL` (PostgreSQL) and `REDIS_URL` are required; settings fail with a clear message if either is missing. `REDIS_URL` may be `redis://...` or `rediss://...` (TLS); if a `rediss://` URL has no `ssl_cert_reqs`, `?ssl_cert_reqs=required` is added automatically. `.env` is git-ignored; never commit it.

### Local services (cloud environment)

```bash
./scripts/dev_services.sh
```

Installs (via apt, if missing) and starts PostgreSQL and Redis, creates the `medreminder` database and a dev-only role, and is safe to re-run in every new session. Then:

```bash
python manage.py migrate
python scripts/check_redis.py   # confirms the Redis connection
```

Local `.env` values: `DATABASE_URL=postgres://medreminder:medreminder@localhost:5432/medreminder`, `REDIS_URL=redis://localhost:6379/0`.

## Run (three separate terminals, venv activated in each)

```bash
python manage.py runserver
```

```bash
celery -A config worker -l info
```

```bash
celery -A config beat -l info
```

## Verify

```bash
curl localhost:8000/health/        # {"status": "OK", "database": "ok", "redis": "ok"}
python manage.py shell -c "from notifications.tasks import ping; print(ping.delay().get(timeout=10))"   # pong
pytest
```

## Accounts API

Interactive docs: http://localhost:8000/api/docs/ (schema at `/api/schema/`).

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/register/` | email, password, role (`patient`/`caregiver`/`doctor`), `timezone` (required for patients, IANA), optional `phone_number` |
| `POST /api/auth/login/` | email + password → `access` and `refresh` JWTs |
| `POST /api/auth/refresh/` | `refresh` → new `access` |
| `GET/PATCH /api/me/` | current user (and patient profile); role and email are read-only |

Role permission classes live in `accounts/permissions.py`: `IsPatient`, `IsCaregiver`, `IsDoctor`.
The custom user model (`accounts.User`) must exist from the first migration: if you have a database
migrated before it was added, recreate the dev database (`dropdb medreminder && createdb medreminder`).

Doctor and caregiver verification (confirming real credentials or identity) is out of scope for this project.

## Medications and schedules API (patients only)

| Endpoint | Purpose |
|---|---|
| `GET/POST /api/medications/` | list (`?active=true\|false`) / create |
| `GET/PATCH /api/medications/{id}/` | read / update |
| `POST /api/medications/{id}/deactivate/` | stop a medication; history is kept (no DELETE) |
| `GET/POST /api/medications/{id}/schedules/` | list / create schedules |
| `GET/PATCH/DELETE /api/medications/{id}/schedules/{sid}/` | read / update / delete a schedule |

Schedule `times_of_day` are local wall-clock `HH:MM` strings in the patient's timezone (stored naive, converted
to UTC only when doses are generated, so DST is handled there). `days_of_week` is 0=Monday..6=Sunday, default every day.
Patients only see their own data; other patients' ids return 404, caregivers/doctors get 403.

## Dose events

`scheduling.DoseEvent` is one concrete dose at a UTC instant (`pending`, `reminded`, `taken`, `missed`, `skipped`).
A unique constraint on `(schedule, scheduled_at)` means the same dose can never exist twice.

- **Generation** (`scheduling/services.py`): `generate_dose_events(schedule, from_date, to_date)` converts the
  schedule's local times to UTC with the patient's IANA zone at generation time. It is idempotent and only creates
  doses in the future. Inactive schedules and inactive medications produce nothing. `days_of_week`, `start_date`
  and `end_date` (of the schedule and of the medication) are local dates in the patient's zone.
- **DST**: a local time that does not exist (spring-forward gap) is shifted forward by the gap (02:30 → 03:30);
  a local time that happens twice (fall-back) is scheduled once, at its first occurrence.
- **Daily job**: Celery Beat runs `scheduling.tasks.generate_upcoming_doses` at 00:10 UTC and keeps 7 days of future
  doses for every active schedule. It is safe to re-run.
- **On change**: creating or editing a schedule, changing or deactivating a medication, or changing the patient's
  timezone resyncs doses straight away. Deleting or changing a schedule, or deactivating a medication, removes
  only **future pending** doses. Taken, missed, skipped and reminded doses and anything in the past are never touched.
- **History**: dose events store the patient and medication directly; deleting a schedule sets `schedule` to NULL
  and keeps the history. Medications with dose history cannot be hard-deleted (deactivate them instead).

## Reminders (notifications app)

Celery Beat runs `notifications.tasks.dispatch_reminders` every minute and `notifications.tasks.mark_missed_doses`
every 5 minutes. Email is the real channel (console backend in development, so reminders are printed in the worker
terminal). `SmsChannel` and `WhatsAppChannel` are log-only stubs behind the same `NotificationChannel` interface;
enable channels with `NOTIFICATION_CHANNELS` (default `email`). Patients with a channel switched off in their
`notification_preferences` are skipped for that channel.

**Pipeline (claim, then send):**
1. *Claim* (one short transaction): `SELECT … FOR UPDATE SKIP LOCKED` on pending doses due in
   `[now − grace, now + lead]`, mark them `reminded`, and insert one `NotificationLog` per channel with status
   `sending` and a one-time lease token (`(dose_event, channel)` is unique). Commit.
2. *Send* (no transaction held): the delivery task swaps the lease token with a conditional UPDATE. Only the
   one caller that wins the swap sends. It then records `sent`, or the error plus a retry with exponential backoff
   (60 s, 120 s, 240 s …), or `failed` after `REMINDER_MAX_ATTEMPTS`.
3. *Recover*: a `sending` row whose lease expired (worker died mid-send, or the task was never queued) is given a
   new lease and sent. The old token is dead, so a late copy of the old task sends nothing.

**Delivery guarantee: at-least-once per dose and channel.** A reminder is sent twice only in one narrow window: the
mail server accepted the message and the worker then died (or lost its database connection) before committing
`sent`. Recovery resends it after `REMINDER_SENDING_TIMEOUT_SECONDS` (default 10 min), with the same `Message-ID`
header. Two workers, overlapping Beat ticks, task retries and broker redeliveries cannot cause a duplicate.
At-least-once was chosen because a rare duplicate reminder is less harmful than a silently lost one. The full
reasoning is in the docstring of `notifications/services.py`.

Doses still untaken `DOSE_MISSED_AFTER_MINUTES` after their time become `missed` (with `missed_at`), whether they
were reminded or not. A dose more than `REMINDER_GRACE_MINUTES` late (workers down that long) is not reminded.

| Setting (env var) | Default | Meaning |
|---|---|---|
| `REMINDER_LEAD_SECONDS` | 60 | Send this long before the dose time |
| `REMINDER_GRACE_MINUTES` | 60 | Still send this late (e.g. after worker downtime) |
| `REMINDER_SENDING_TIMEOUT_SECONDS` | 600 | Lease; a `sending` row older than this is recovered |
| `REMINDER_MAX_ATTEMPTS` | 5 | Attempts before a reminder is recorded as `failed` |
| `REMINDER_RETRY_BASE_SECONDS` | 60 | First retry delay; doubles each attempt |
| `DOSE_MISSED_AFTER_MINUTES` | 120 | Untaken this long after its time → `missed` |
| `EMAIL_TIMEOUT` | 30 | Seconds per SMTP send (the task is hard-killed at +30 s) |
| `NOTIFICATION_CHANNELS` | `email` | Comma-separated: `email`, `sms`, `whatsapp` |

Settings refuse a grace period at or above the missed window, and a lease shorter than twice the send time limit.

## Dose actions API (patients only)

| Endpoint | Purpose |
|---|---|
| `GET /api/doses/today/` | every dose in the patient's local day (UTC `scheduled_at` plus `scheduled_local`) |
| `GET /api/doses/upcoming/?days=7` | pending/reminded doses from now on (1-30 days, default 7) |
| `POST /api/doses/{id}/taken/` | mark taken; records `taken_at` |
| `POST /api/doses/{id}/skip/` | mark skipped |

Rules: `pending`, `reminded` and `missed` doses can be marked taken. A missed dose marked taken keeps `missed_at` and is
flagged `taken_late=true`, so reports can tell it apart. Pending/reminded doses can be skipped. Repeating an action is a
no-op that returns the same dose (200). A taken dose is final: it cannot be skipped, and the missed-dose job never touches
it. Other conflicts return 409. Another patient's dose id returns 404. Each action locks the dose row, so simultaneous
requests (double click, link plus app, the missed job) are serialised.

### One-click link in the reminder email

The email contains `SITE_BASE_URL/dose/taken/<token>/`. The token is a `django.core.signing` value carrying the dose id and
the patient id; it expires after 24 hours and cannot act on any other dose. **Opening the link (GET or HEAD) changes
nothing**, because mail scanners and link previews prefetch URLs: it shows a small confirmation page, and only that page's
POST marks the dose taken. Using the link twice is safe. The POST is CSRF-exempt on purpose: there is no session, and the
signed token is the credential. Pages are sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
Set `SITE_BASE_URL` to your public address, and `DJANGO_SECRET_KEY` (required when `DJANGO_DEBUG` is not `true`), since links
are signed with it. In development the console email backend prints the full link in the worker output.

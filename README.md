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

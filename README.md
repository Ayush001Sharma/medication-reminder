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

# Medication Reminder and Adherence Tracker

Health-tech backend (no frontend). Patients add prescriptions with dose schedules. The system sends reminders and tracks which doses were taken. Caregivers and doctors can see an adherence report for patients who gave them access.

## Stack

- Python 3.12, Django 5, Django REST Framework
- PostgreSQL (via `DATABASE_URL`)
- Celery + Redis (Celery Beat for scheduling)
- JWT auth: djangorestframework-simplejwt
- API docs: drf-spectacular (Swagger)
- Tests: pytest + pytest-django
- No Docker and no Homebrew.

## Environment

- Work in the cloud environment, not on the developer's computer.
- Use the Python version available there (3.12 or newer). Choose Django and package versions that support it, and tell the developer about any incompatibility.
- Commit work with clear messages and push to a branch after each task.

## Database

- PostgreSQL, configured through `DATABASE_URL`.
- In the Claude Code web cloud environment, install and run PostgreSQL inside the environment for development and tests (try apt).
- If installation is blocked by network settings, say so and ask the developer to provide a hosted PostgreSQL.

## Redis

- One variable, `REDIS_URL`, used for both the Celery broker and the Celery result backend.
- In the cloud environment, install and run Redis inside the environment for development and tests (try apt) with `REDIS_URL=redis://localhost:6379/0`.
- Settings must also accept a TLS URL (`rediss://...`) so the project can later use hosted Upstash Redis. If a `rediss://` URL has no `ssl_cert_reqs` parameter, add `?ssl_cert_reqs=required`.
- Never print or commit secret values.

## Secrets workflow

- Keep real credentials out of the repository.
- Commit only `.env.example` with placeholder values. List `.env` in `.gitignore`.
- Local development and tests in the cloud environment need no real secrets.
- Only if the developer switches to hosted services: STOP and tell the developer which environment variables to add in the environment settings.
- Never ask the developer to paste secrets into the chat. Never echo secret values in output or logs.

## Roles and access

- Roles: `patient`, `caregiver`, `doctor`.
- A caregiver or doctor can only see a patient's data after the patient grants access. The patient can revoke it at any time.

## Key rules

1. **Time:** All datetimes are stored in UTC. Each patient has an IANA timezone (e.g. `Asia/Kolkata`). Use `zoneinfo`. Schedules are defined in the patient's local time and must stay correct across daylight saving changes.
2. **Reminder delivery:** A reminder must never be sent twice and must never be missed. Use database constraints, row locking and idempotent tasks to guarantee this.
3. **No secrets in code.** Use environment variables and a `.env.example` file.
4. **Tests and readability:** Write tests for every feature. Keep code readable with small functions and docstrings on non-obvious logic.
5. **Structure:** Django apps named `accounts`, `medications`, `scheduling`, `notifications`, `reports`.
6. **Task wrap-up:** After finishing each task, summarise what changed and how to run it.

## Notifications

- Email is the real channel (console email backend in development).
- Define a notification-channel interface so SMS/WhatsApp can be added later.

## Frontend

- A web frontend lives in `frontend/` (React 18, Vite, TypeScript, Tailwind, React Router, Recharts, Vitest). The backend
  stays API-only; the only backend change for it is CORS (`CORS_ALLOWED_ORIGINS`).
- Use only the design tokens in `frontend/src/index.css`; respect the contrast rules documented there.

## Do not

- Send real WhatsApp/SMS messages.

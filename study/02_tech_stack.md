# 02. The tech stack: what each tool does here, and why it fits

## A note on "why was it chosen?"

The project brief (`CLAUDE.md`) fixed the stack: Python 3.12+, Django 5, Django REST Framework, PostgreSQL,
Celery with Redis, JWT authentication with `djangorestframework-simplejwt`, API docs with `drf-spectacular`,
and `pytest`. So the honest interview answer is: **"The stack was set by the project brief, and here is why
each piece is a sound fit for this problem."** Each section below therefore gives you (1) what the tool is,
(2) where it appears in this repository, (3) the reason it fits, with evidence from the code, and (4) what
the alternatives would have cost. Do not invent history ("we benchmarked five options"); do argue the
trade-offs, which is what interviewers want.

The pinned versions are in `requirements.txt`:

*From `requirements.txt`:*

```text
celery==5.7.0
coverage==7.17.5
dj-database-url==3.1.2
django-cors-headers==4.9.0
Django==5.2.19
djangorestframework==3.18.3
djangorestframework_simplejwt==5.5.1
drf-spectacular==0.30.0
psycopg-binary==3.3.9
psycopg==3.3.9
pytest-cov==7.1.0
pytest-django==4.14.0
pytest==9.2.0
python-dotenv==1.2.4
redis==8.2.0
tzdata==2026.6
```

## 1. How the pieces fit together

| Layer | Technology | One-line job |
|---|---|---|
| Language | Python 3.12 / 3.13 | Runs everything; `zoneinfo` for time zones |
| Web framework | Django 5.2 | ORM, migrations, admin, auth, signals, signing, cache, email |
| API toolkit | Django REST Framework | Serializers (validation), viewsets, permissions, throttling |
| Authentication | `djangorestframework-simplejwt` | Signed JWT access and refresh tokens |
| API docs | `drf-spectacular` | OpenAPI schema and Swagger UI at `/api/docs/` |
| Browser access | `django-cors-headers` | Lets the web frontend on another origin call `/api/` |
| Database | PostgreSQL 16 + `psycopg` 3 | Source of truth, constraints, row locks |
| Queue and cache | Redis + `redis` client | Celery broker and result backend; rate-limit cache |
| Background jobs | Celery + Celery Beat | Run tasks; run them on a timetable |
| Config | `python-dotenv`, `dj-database-url`, `config/env.py` | Settings from environment variables, failing loudly |
| Testing | `pytest`, `pytest-django`, `pytest-cov`, `coverage` | 460 tests, coverage floor 95% |
| CI | GitHub Actions | Runs tests on Python 3.12 and 3.13 with real PostgreSQL and Redis |

## 2. Python (3.12 and 3.13)

**What it does here.** Everything. Two language features matter for this project:

* **`zoneinfo`** (standard library since 3.9) reads the IANA time zone database. `medications/utils.py`
  turns a patient's stored name into a time zone object:

*From `medications/utils.py`, `patient_timezone`:*

```python
def patient_timezone(user) -> ZoneInfo:
    """The patient's IANA zone as a ZoneInfo (UTC if the user has no profile)."""
    profile = getattr(user, "patient_profile", None)
    return ZoneInfo(profile.timezone) if profile else UTC
```

* **Type hints** such as `datetime | None` (used in `scheduling/services.py`) document what functions accept.

**Why it fits.** `zoneinfo` correctly applies daylight saving rules, which is the core difficulty of this
project (chapter 06). `tzdata` is pinned in `requirements.txt` because Python's `zoneinfo` needs a time zone
database to read, and some systems (notably Windows and minimal containers) do not ship one.

**Alternatives.** `pytz` is the older library; it needs `localize()` calls and is easy to misuse, so
`zoneinfo` is the modern default. `python-dateutil` also works but is not needed.

**Why two versions?** The GitHub Actions matrix runs the whole suite on 3.12 and 3.13, so the code does not
accidentally depend on one interpreter (`.github/workflows/tests.yml`).

## 3. Django 5.2

**What it is.** A "batteries included" web framework: database access (the ORM), schema migrations, an admin
site, user authentication, URL routing, signals, caching, email, and signing utilities.

**Where each battery is used here:**

| Django feature | Used for | File |
|---|---|---|
| ORM and models | Every table | `*/models.py` |
| Migrations | Creating and evolving the schema | `*/migrations/` |
| Custom user model | Email login with a `role` | `accounts/models.py` (`User`) |
| Password hashing and validators | Storing passwords safely | `config/settings.py` (`AUTH_PASSWORD_VALIDATORS`) |
| Signals | Regenerate doses when a schedule changes | `scheduling/signals.py` |
| `django.core.signing` | The signed one-click link | `scheduling/links.py` |
| Cache framework | Rate-limit counters (Redis) | `config/settings.py` (`CACHES`) |
| Email framework | Reminder emails | `notifications/channels.py` |
| Templates | The link confirmation page | `scheduling/templates/scheduling/dose_link.html` |
| Admin | Inspecting data | `*/admin.py` |

Django 5.2 features visible in the code: `CheckConstraint(condition=...)` (the keyword is `condition` in recent
versions), `select_for_update(skip_locked=True, of=("self",))`, `bulk_create(ignore_conflicts=True)`, partial
indexes with `condition=`, and covering indexes with `include=`.

**Why it fits.** The product needs a relational model with strict rules, an admin view, authentication,
migrations and email: Django provides all of that in one consistent package, so the project spends its effort
on the unusual parts (time zones, reminders, consent).

**Alternatives.**

* *Flask or FastAPI:* lighter, but you assemble the ORM, migrations, auth and admin yourself. FastAPI shines
  for async, high-throughput APIs; this system's hard problems are correctness and concurrency in the
  database, not request throughput.
* *Node/Express or Spring Boot:* perfectly capable; the brief chose Python.

## 4. Django REST Framework (DRF) 3.18

**What it adds to Django.** Tools to build JSON APIs: **serializers** (validate input and shape output),
**viewsets and routers**, **permission classes**, **throttles** (rate limits), **authentication classes**, and
automatic handling of status codes. In this project:

* Validation lives in serializers: `MedicationSerializer`, `ScheduleSerializer`, `RegisterSerializer`.
* Authorisation lives in `accounts/permissions.py` and in each view's `get_queryset`.
* Rate limits are DRF throttles in `config/ratelimit.py`.
* DRF's global defaults are set once in settings:

*From `config/settings.py`, `REST_FRAMEWORK`:*

```python
REST_FRAMEWORK = {
    # 0 = trust only the socket address. Behind N reverse proxies set NUM_PROXIES=N, otherwise a
    # client could send a fake X-Forwarded-For header and dodge the rate limits.
    "NUM_PROXIES": env_int("NUM_PROXIES", 0),
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
}
```

Notice the **secure default**: every view requires login unless it explicitly says otherwise (for example
`RegisterView` sets `permission_classes = [permissions.AllowAny]`). Forgetting a permission therefore makes an
endpoint *safer*, not wide open.

**Order DRF runs the checks.** DRF's `APIView.initial()` performs authentication, then permission checks, then
throttles (I read this in DRF's own source file `rest_framework/views.py`, inside the installed package: `perform_authentication`, `check_permissions`,
`check_throttles`). So on a view that requires login, an unauthenticated request is rejected with 401 before any throttle counts it.

**Alternatives.** *Django Ninja* (type-hint driven, similar goals) or plain Django views (you would write
validation and permission plumbing yourself).

## 5. JWT with `djangorestframework-simplejwt`

**What it does.** Issues and verifies JSON Web Tokens: a short-lived **access** token sent with every
request, and a longer-lived **refresh** token used to get a new access token. Details in chapter 04.

*From `config/settings.py`, `SIMPLE_JWT`:*

```python
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
}
```

**Why it fits.** The API is consumed by a separate frontend (and could be used by mobile apps). Tokens in an
`Authorization` header avoid cookies, so there is no CSRF problem for the API and CORS can stay simple
(`CORS_ALLOW_CREDENTIALS` stays false, see the comment in `config/settings.py`).

**Trade-off (be honest about it).** A JWT is valid until it expires; there is no server-side "log out". This
project does not use the token blacklist and does not rotate refresh tokens (README "Known limitations"), so a
stolen refresh token works for up to 7 days. Keeping the access token to 30 minutes limits the damage of a
stolen access token.

**Alternatives.** *Session cookies* (simple and revocable, but need CSRF handling and are awkward for mobile
apps), *DRF TokenAuthentication* (a never-expiring random token), *OAuth2* (powerful but heavy for a first-party
app).

## 6. `drf-spectacular` (OpenAPI and Swagger)

**What it does.** Reads the views and serializers and generates an OpenAPI schema, served at
`/api/schema/`, with an interactive Swagger page at `/api/docs/` (`config/urls.py`). Views add hints with
`@extend_schema`, for example on `MedicationViewSet.deactivate`.

**Why it fits.** A documented API is usable by the frontend developer without reading the code. The
interactive page is also the easiest way for *you* to experiment while studying.

**Alternatives.** `drf-yasg` (older, less maintained), or hand-written docs that drift out of date.

## 7. `django-cors-headers`

**What it does.** Browsers refuse to let a page on one origin (`http://localhost:5173`) read responses from
another (`http://localhost:8000`) unless the server opts in with CORS headers. This package adds them.

**Where.** `CorsMiddleware` is the first entry in `MIDDLEWARE`. The allowed origins come from the
`CORS_ALLOWED_ORIGINS` environment variable, parsed strictly by `env_origins` in `config/env.py` (a wildcard
or a path is rejected at startup). `CORS_URLS_REGEX = r"^/api/.*$"` exposes only `/api/`, and `Retry-After` is
exposed so the frontend can read how long to wait after a 429.

## 8. PostgreSQL 16 (with `psycopg` 3 and `dj-database-url`)

**What it is.** A relational database. It is the *source of truth* in this project, and the part that
guarantees correctness even when the Python code has a bug or two requests collide.

**PostgreSQL features this project relies on (and that MySQL or SQLite would not all give you):**

| Feature | Where | Why |
|---|---|---|
| `ArrayField` columns | `Schedule.times_of_day`, `days_of_week` | Store a list of times in one column |
| Partial unique index | `AccessGrant` (`one_open_grant_per_patient_and_email`) | "Only one open grant per pair" but allow history |
| Partial indexes | `dose_open_idx`, `notif_sending_idx` | Index only the few rows the hot queries read |
| Covering index (`INCLUDE`) | `dose_patient_cover_idx` | Index-only scans for reports |
| `SELECT ... FOR UPDATE SKIP LOCKED` | `claim_due_doses` | Workers skip rows another worker holds |
| CHECK constraints | Several models | Data rules enforced by the database |
| `JSONField` with `has_key` | `notification_preferences` | Query inside JSON |

**Configuration.** One environment variable, parsed by `dj-database-url`, with connection reuse:

*From `config/settings.py`, `DATABASES`:*

```python
DATABASES = {
    "default": dj_database_url.parse(require_env("DATABASE_URL"), conn_max_age=60)
}
```

**Why it fits.** Reminders must never be sent twice or missed. That needs real transactions, row locks and
constraints, which PostgreSQL does very well. The test suite even races real threads against it.

**Alternatives.**

* *SQLite:* no real row-level concurrency, no `SKIP LOCKED`; fine for a toy.
* *MySQL/MariaDB:* has transactions, but no `ArrayField` or partial indexes in the same way.
* *MongoDB:* flexible documents, but weaker multi-row constraints, a poor fit for "unique per (schedule,
  time)" style rules.

## 9. Redis (and the `redis` Python client)

**What it does here.** Three roles, all from one `REDIS_URL`:

1. **Celery broker:** the queue of tasks waiting for a worker.
2. **Celery result backend:** where task results can be stored.
3. **Django cache:** the rate-limit counters (`CACHES` with `KEY_PREFIX: "medreminder"`).

*From `config/settings.py`, Redis and cache:*

```python
REDIS_URL = normalize_redis_url(require_env("REDIS_URL"))
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL
```

`normalize_redis_url` (`config/env.py`) adds `ssl_cert_reqs=required` to a TLS `rediss://` URL when the
parameter is missing, so the project can use a hosted Redis safely. The `/health/` endpoint pings Redis
(`config/health.py`).

**Important design point.** Redis is *not* the source of truth. If Redis loses data, the database still knows
which doses exist and which reminders were claimed; the next Beat tick recovers. Rate limiting is designed to
**fail open**: if Redis is down, requests are allowed and an error is logged (`ConfiguredThrottle` in
`config/ratelimit.py`), so a cache outage cannot become a login outage.

**Alternatives.** *RabbitMQ* is a more featureful broker (Celery supports it) but is another system to run;
Redis already serves three roles here. *A database table as a queue* is possible but adds load and polling.

## 10. Celery 5.7 and Celery Beat

**What it does.** Celery runs **tasks** (Python functions) in worker processes, taking them from the broker.
**Beat** is a separate process that enqueues tasks on a timetable (`CELERY_BEAT_SCHEDULE`, see chapter 01).

**Where.** `config/celery.py` creates the app and auto-discovers `tasks.py` in every installed app; the tasks
are `dispatch_reminders`, `deliver_notification`, `mark_missed_doses`, `generate_upcoming_doses` and
`send_weekly_summaries`. The configuration lines that matter:

*From `config/settings.py`, Celery settings:*

```python
CELERY_TIMEZONE = "UTC"
CELERY_TASK_ACKS_LATE = True
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
```

`CELERY_TASK_ACKS_LATE = True` means a task is acknowledged to the broker only *after* it finishes. If a
worker crashes mid-task, the broker redelivers it. That is good for not losing work, and it is exactly why every
task here is written to be **idempotent**: a task may run twice, and the result must be the same as running it
once.

The email-sending task has hard limits so a stuck send cannot outlive its lease:

*From `notifications/tasks.py`, `deliver_notification`:*

```python
@shared_task(
    ignore_result=True,
    soft_time_limit=settings.EMAIL_TIMEOUT + 15,
    time_limit=settings.EMAIL_TIMEOUT + 30,  # hard kill: a send can never outlive its lease
)
def deliver_notification(log_id: int, token: str) -> str:
    """One delivery attempt. Idempotent: a retried or redelivered copy sends nothing."""
    return services.deliver(log_id, token)
```

**Eager mode in tests.** In tests (`conftest.py`, fixture `celery_eager`) Celery is switched to
`task_always_eager`: tasks run immediately in the calling thread, with no broker. That makes tests simple and
fast. (A subtle consequence, a real bug that was found and fixed in this project, is documented in `README.md` under "Running the tests".)

**Alternatives.**

* *Cron plus management commands:* simple, but no queue, no retries, no way to spread work over workers.
* *RQ, Dramatiq, Huey:* lighter task queues; Celery has the richest feature set (Beat, retries, time limits)
  and is the common industry answer.
* *APScheduler inside the web process:* couples the clock to the web server and runs duplicates if you scale
  the web process.

## 11. Email

**What it does.** `EmailChannel.send` in `notifications/channels.py` builds a Django `EmailMessage` and sends
it with whatever `EMAIL_BACKEND` is configured. In development that is the **console backend** (the email is
printed in the worker's terminal), in production SMTP.

It sets a stable `Message-ID` header so that, if a reminder is resent after a crash, mail systems can collapse
the duplicate. The channel is an **interface** (`NotificationChannel`), with SMS and WhatsApp as log-only
stubs, so a new provider means one new class, not a rewrite.

## 12. Configuration: `python-dotenv` and `config/env.py`

**Idea.** Configuration (database URL, secrets, switches) is read from **environment variables**, never
hard-coded. A `.env` file (git-ignored) is loaded for convenience; `.env.example` documents every variable with
placeholder values.

`config/env.py` adds small helpers: `require_env` (fails with a clear message), `env_int`, `env_bool`,
`env_list`, `env_origins`, `normalize_redis_url`, `validate_rate`, `validate_secret_key`. Misconfiguration
**fails at startup**, not at 3 a.m.

*From `config/env.py`, `require_env`:*

```python
def require_env(name: str) -> str:
    """Return a required environment variable or fail with a clear message."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise ImproperlyConfigured(
            f"Missing required environment variable {name}. "
            f"Copy .env.example to .env and set {name} (see README)."
        )
    return value
```

## 13. Django's built-in security pieces used here

* **Password hashing.** Django stores passwords as PBKDF2-SHA256 hashes (I checked: a stored password starts
  with `pbkdf2_sha256$1000000$...`, so a million iterations, and the plain password is not in the column).
* **Password validators.** Four are enabled in `AUTH_PASSWORD_VALIDATORS`: similarity to user attributes,
  minimum length, common passwords, all-numeric.
* **`django.core.signing`** signs the one-click link with `SECRET_KEY` plus a salt and a timestamp
  (`scheduling/links.py`). `validate_secret_key` refuses a weak or default key whenever `DEBUG` is not true.

## 14. Logging

`config/logging_utils.py` gives one helper, `log_event(logger, "reminder.sent", log_id=7, ...)`, and a
formatter that prints either readable `event key=value` lines or one JSON object per line
(`LOG_FORMAT=json`) for log aggregation. A privacy rule is written in its docstring: log identifiers and
counts only, never emails, tokens or medication names.

## 15. Testing: pytest, pytest-django, pytest-cov

* **pytest** with fixtures (`conftest.py`: `patient`, `other_patient`, `patient_api`, `celery_eager`, ...).
* **pytest-django** gives database access (`@pytest.mark.django_db`) and runs tests in transactions;
  concurrency tests use `transaction=True` because they need real commits across threads.
* **pytest-cov / coverage** measures line and branch coverage; CI fails below 95%
  (`--cov-fail-under=95`).
* Some tests are *configuration* tests: they start Django in a subprocess with a bad setting and assert it
  fails with a clear message (`tests/test_settings_validation.py`).

## 16. CI: GitHub Actions

`.github/workflows/tests.yml` runs on every push and pull request with a **matrix** of Python 3.12 and 3.13,
**PostgreSQL 16 and Redis 7 as service containers**, so the concurrency tests run against the real databases.
A separate job lints, tests and builds the frontend.

## 17. Not in scope here: the frontend

`frontend/` is a React + TypeScript single-page app built with Vite, calling this API. It is a separate
project; the backend stays API-only (the only backend change for it is CORS).

## Interview questions on this chapter

1. **Q: Why Django REST Framework on top of Django?**
   **A:** Plain Django renders HTML; DRF adds what an API needs: serializers that validate input and format
   output, viewsets and routers, permission classes, authentication classes and throttling, with consistent
   error responses. In this project validation lives in serializers, authorisation in permission classes and
   queryset filtering, and rate limits in throttles.

2. **Q: Why PostgreSQL rather than SQLite or MySQL?**
   **A:** I need real concurrency control and rich constraints: row locks with `SKIP LOCKED` so workers don't
   claim the same dose, partial unique indexes for "one open grant per pair", `CHECK` constraints, array
   columns, and covering indexes. SQLite has no row-level concurrency; MySQL lacks several of these features.

3. **Q: What does Redis do here, and what happens if it goes down?**
   **A:** It is the Celery broker and result backend and the cache for rate-limit counters. It is not the
   source of truth. If it goes down, rate limiting fails open (requests are allowed and an error is logged),
   and background tasks pause; after it returns, the next Beat tick re-claims due doses from the database.

4. **Q: Celery vs a cron job?**
   **A:** Cron starts a script on a timer, with no queue, no retries, and no spreading work across machines.
   Celery gives a queue, workers that can scale, retries, time limits, and Beat for scheduling. Reminders
   need retries with back-off and recovery of failed sends, which Celery supports.

5. **Q: What is `CELERY_TASK_ACKS_LATE` and why does it matter?**
   **A:** It makes workers acknowledge a task after it finishes, so a task whose worker crashed is redelivered.
   That prevents lost work but means a task can run more than once, so every task must be idempotent. Mine
   are: claiming uses a unique constraint, and sending swaps a one-time lease token.

6. **Q: JWT or sessions? What is the downside of your choice?**
   **A:** JWT in an `Authorization` header suits a separate frontend or mobile app and avoids cookies and CSRF.
   The downside is revocation: a token is valid until it expires and I do not use the blacklist or refresh
   rotation, so a stolen refresh token works for up to 7 days. I mitigate with a 30-minute access token, and
   I would add rotation and blacklisting first if hardening.

7. **Q: Why store configuration in environment variables?**
   **A:** The same code runs in development, CI and production with different values, secrets stay out of git
   (`.env` is ignored, only `.env.example` with placeholders is committed), and misconfiguration fails at
   startup with a clear message via helpers like `require_env`.

8. **Q: What is eager mode and when is it used?**
   **A:** `task_always_eager` runs tasks synchronously in the calling thread without a broker. It is used only
   in tests (`conftest.py`) so tests are fast and deterministic. It is never enabled in production.

9. **Q: Why is `tzdata` in `requirements.txt`?**
   **A:** `zoneinfo` needs a time zone database. Many Linux systems have one, but Windows and slim containers
   may not, so the package guarantees the data is available everywhere.

10. **Q: How is the API documented?**
    **A:** `drf-spectacular` generates an OpenAPI schema from serializers and views, served at `/api/schema/`
    with Swagger UI at `/api/docs/`. I add `@extend_schema` hints where DRF cannot infer the shape.

## Common mistakes to avoid

* **Saying "I chose" a technology you did not choose.** Say the brief specified it and explain why it fits.
* **Calling Redis "the database".** It is a broker and cache here; PostgreSQL holds the truth.
* **Mixing up Celery and Beat.** Celery workers run tasks; Beat only schedules them. Two separate processes.
* **Saying JWT is "more secure than sessions".** It is different: stateless and good for APIs, but hard to
  revoke. State the trade-off.
* **Forgetting `tzdata`.** "Works on my machine" time zone bugs are often a missing time zone database.
* **Describing eager mode as a production feature.** It is a test convenience.
* **Hard-coding secrets or URLs.** Everything configurable comes from the environment; only placeholders are
  committed.

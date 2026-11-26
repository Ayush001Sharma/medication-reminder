# 14. CI and running everything locally

Two practical topics that interviewers like because they show you can *ship* and *operate* software: the
**continuous integration** pipeline (what runs automatically on every push), and **how to run the whole system
yourself** on macOS, Linux and Windows PowerShell.

## 1. First principles

### What is continuous integration (CI)?

**CI** means that every time someone pushes code, a server automatically builds the project and runs the checks
in a clean, throw-away environment. The point is to find out *immediately* that a change broke something, on a
machine that is not "my laptop with my settings". If the checks fail, the change is not trusted.

Why a clean environment matters: "works on my machine" bugs usually come from things the developer forgot they
had installed or configured. CI starts from nothing, installs exactly what `requirements.txt` says, and runs.

### Why a matrix, and why real services?

* A **matrix** runs the same job several times with different settings. Here: Python 3.12 **and** 3.13, so the
  code is not accidentally tied to one interpreter.
* **Service containers** start real PostgreSQL and Redis next to the job, so the tests (including the real-thread
  concurrency tests) run against the real thing, not mocks.

## 2. The pipeline: `.github/workflows/tests.yml`

GitHub Actions reads this file. It defines a **workflow** (`Tests`) made of **jobs**, each made of **steps**.

### When it runs, and safety settings

*From `.github/workflows/tests.yml`:*

```yaml
name: Tests

on:
  push:
  pull_request:

permissions:
  contents: read

# A newer push to the same branch cancels the older run.
concurrency:
  group: tests-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

* `on: push` and `pull_request`: every push and every pull request.
* `permissions: contents: read`: the workflow gets the **minimum** rights (it can read the code, nothing else).
  This is least privilege applied to CI, so a compromised step cannot write to the repository.
* `concurrency` with `cancel-in-progress`: if you push twice quickly, the older run is cancelled, saving time.

### The backend job: Python 3.12 and 3.13

*From `.github/workflows/tests.yml`, the job header:*

```yaml
jobs:
  test:
    name: Python ${{ matrix.python-version }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        python-version: ["3.12", "3.13"]
```

* `fail-fast: false`: if 3.12 fails, **3.13 still finishes**. That is exactly what let us see "3.12 failed, 3.13
  passed" in the flaky-test story (chapter 13). With fail-fast, the other run would be cancelled and we would lose
  that evidence.
* `timeout-minutes: 20` stops a hung job from running for hours.

### Real PostgreSQL and Redis

*From `.github/workflows/tests.yml`, the PostgreSQL service:*

```yaml
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: ci_user
          POSTGRES_PASSWORD: ci_password
          POSTGRES_DB: medreminder
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U ci_user -d medreminder"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 12
```

*From `.github/workflows/tests.yml`, Redis and the environment:*

```yaml
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 12

    env:
      DATABASE_URL: postgres://ci_user:ci_password@localhost:5432/medreminder
      REDIS_URL: redis://localhost:6379/0
      DJANGO_DEBUG: "true"
```

* The **health checks** make the job wait until PostgreSQL and Redis actually accept connections before the first
  step that needs them.
* The credentials exist **only inside this throwaway job** (the workflow file says so in a comment). The
  configuration reaches the app through the same environment variables as everywhere else (`DATABASE_URL`,
  `REDIS_URL`), which is the twelve-factor idea from chapter 12 in action.

### The steps

*From `.github/workflows/tests.yml`, the checks:*

```yaml
      - name: Django system check
        run: python manage.py check

      - name: Migrations are in sync with the models
        run: python manage.py makemigrations --check --dry-run

      - name: API schema has no warnings
        run: python manage.py spectacular --validate --fail-on-warn --file /dev/null

      - name: Run the tests with coverage
        run: pytest -q --cov --cov-report=term-missing --cov-report=xml --cov-fail-under=95
```

Before these the job checks out the code (`actions/checkout`), installs Python with a pip cache
(`actions/setup-python`) and runs `pip install -r requirements.txt`. Each check, and what it protects:

| Step | What it catches | Result when I ran it locally |
|---|---|---|
| `manage.py check` | Broken settings or model definitions | `System check identified no issues (0 silenced).` |
| `makemigrations --check --dry-run` | Models changed **without** a migration (the database would not match) | `No changes detected` |
| `spectacular --validate --fail-on-warn` | The OpenAPI schema has warnings (an undocumented or ambiguous endpoint) | exit code 0 |
| `pytest --cov ... --cov-fail-under=95` | Any failing test, or coverage below **95%** | all tests pass; coverage about 99.4 to 99.5% |

Finally the coverage report is uploaded as an artifact (only for the 3.13 run, so it is stored once).

The **`--cov-fail-under=95`** is a *floor*: coverage may rise, but a change that drops it below 95% fails the
build. The project rule is never to lower that floor to make a failure go away.

### The frontend job

A second job, `frontend`, runs in parallel with the backend job and checks the React app: install exactly as
locked (`npm ci`), then `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. It sets
`VITE_API_BASE_URL` for the build and takes its Node version from `frontend/.nvmrc`. A failure in either job
marks the push as failed.

### The caveat to mention

CI proves the checks pass in a clean environment; it does not deploy anything. This repository has **no
deployment pipeline**, and the frontend build is not hosted anywhere (chapter 16).

## 3. Running everything locally

The system has **four moving parts** you start yourself (PostgreSQL and Redis run as services):

| Process | Command | Job |
|---|---|---|
| Web API | `python manage.py runserver` | Answers HTTP (port 8000) |
| Celery worker | `celery -A config worker -l info` | Runs tasks (sends emails) |
| Celery Beat | `celery -A config beat -l info` | The clock that enqueues tasks |
| Frontend (optional) | `cd frontend && npm run dev` | The web app (port 5173) |

All three Python processes need the environment from `.env`: at minimum `DATABASE_URL` and `REDIS_URL`
(`.env.example` documents every variable).

### macOS and Linux

You need Python 3.12 or newer, PostgreSQL 16, and a Redis (local `redis://localhost:6379/0` or hosted).

```bash
git clone https://github.com/Ayush001Sharma/medication-reminder.git
cd medication-reminder
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then edit .env (at least DATABASE_URL and REDIS_URL)
```

Create the database and a role (`CREATEDB` lets the tests create their temporary database):

```bash
psql -d postgres -c "CREATE ROLE medreminder LOGIN CREATEDB PASSWORD 'choose-a-password'"
createdb -O medreminder medreminder
```

Put the matching URL in `.env` (`DATABASE_URL=postgres://medreminder:choose-a-password@localhost:5432/medreminder`),
then:

```bash
python manage.py migrate
python scripts/check_redis.py       # confirms REDIS_URL works
python manage.py seed_demo          # optional: demo patients, doctor, caregiver, a week of history
```

I ran `scripts/check_redis.py` and got `Redis OK: ping=True, set/get round trip works`. Start the three
processes, each in its own terminal with the virtualenv active:

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
`http://localhost:8000/api/docs/` is the interactive Swagger page. In development, **emails are printed in the
worker's terminal** (the console backend), so you can see reminders without an email server.

### Windows PowerShell

The README gives a full walkthrough; here is the shape and the Windows-specific traps. **Honesty note from the
README:** these steps were walked through command by command, but **not executed on a Windows machine**.

1. Install Python 3.12+ (tick *Add python.exe to PATH*), Git for Windows and PostgreSQL 16, plus a **hosted
   Redis** (Redis does not run natively on Windows). Use its TLS URL (`rediss://...`).
2. Create the virtual environment and install:

```powershell
git clone https://github.com/Ayush001Sharma/medication-reminder.git
cd medication-reminder
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

3. `psql` is not on the PATH, so call it by its folder:

```powershell
$pg = "C:\Program Files\PostgreSQL\16\bin"
& "$pg\psql.exe" -U postgres -c "CREATE ROLE medreminder LOGIN CREATEDB PASSWORD 'choose-a-password';"
& "$pg\createdb.exe" -U postgres -O medreminder medreminder
```

4. `Copy-Item .env.example .env`, edit it in an editor (keep UTF-8), set `DATABASE_URL` and `REDIS_URL`, then:

```powershell
python manage.py migrate
python scripts\check_redis.py
python manage.py seed_demo
```

5. Run each process in its **own PowerShell window** (activate the virtualenv in each). The worker needs a flag:

```powershell
python manage.py runserver
```
```powershell
celery -A config worker -l info --pool=solo
```
```powershell
celery -A config beat -l info
```

6. Check: `Invoke-RestMethod http://localhost:8000/health/`.

The most important Windows differences, with reasons:

| Trap | Reason and fix |
|---|---|
| Worker must use `--pool=solo` | Celery's default `prefork` pool does not work on Windows. Do not use `celery worker -B` either; run Beat separately |
| `solo` runs **one task at a time** and cannot enforce the hard time limit | A slow email delays the next reminder, and a send stuck in the mail server is not killed. Fine for development; use Linux workers in production (README) |
| `.env` created with `>` or `echo` in PowerShell 5.1 is **UTF-16** | The app detects it and says `.env is not a UTF-8 text file`; recreate with `Copy-Item .env.example .env` (`load_env_file` and its test cover this) |
| `curl` is an alias for `Invoke-WebRequest` in PowerShell 5.1 | Use `Invoke-RestMethod` or `curl.exe` |
| Passwords with `@`, `:` or `/` in `DATABASE_URL` | URL-encode them (`@` becomes `%40`) |
| Script execution disabled on activation | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` for that window only |

### The cloud development container (this project's own sandbox)

`scripts/dev_services.sh` installs and starts PostgreSQL and Redis inside the project's Linux cloud sandbox and
creates a development-only role `medreminder` (password `medreminder`, with `LOGIN` and `CREATEDB` but **not**
superuser). The README is explicit that you never need it elsewhere, and that role and password must never be
reused anywhere reachable from a network.

### Running the tests

```bash
pytest                       # whole backend suite (needs PostgreSQL and Redis, see the note below)
pytest --cov --cov-report=term-missing
cd frontend && npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

**A note on Redis and the tests (verified).** The README says Redis is needed only for one integration test that
skips itself when Redis is unreachable. I stopped Redis and ran `tests/test_skeleton.py` and `tests/test_health.py`:
**one test skipped** (`test_real_redis_and_database`, as the README says) but **one test failed**
(`tests/test_skeleton.py::test_health_ok`, `assert 503 == 200`, because `/health/` really pings Redis). So a
running Redis is needed to get a fully green suite; the README sentence is slightly out of date. (CI always has
a Redis container.)

### When something is not working: a checklist

1. `curl localhost:8000/health/` shows which of `database` or `redis` is down (and only the error *class*).
2. No emails appearing? Is the **worker** running *and* **Beat** running? Beat only schedules; the worker runs.
3. `python manage.py check` and the startup message: bad settings fail loudly (chapter 12).
4. Are there doses due? `seed_demo` creates a week of history and the next seven days.
5. `LOG_FORMAT=json LOG_LEVEL=DEBUG` for more detail; look for `reminder.*` events (chapter 07).

## Interview questions on this chapter

1. **Q: What does your CI do?**
   **A:** On every push and pull request it runs two parallel jobs. The backend job runs on Python 3.12 and 3.13
   with real PostgreSQL 16 and Redis 7 containers: Django's system check, a migrations-in-sync check, OpenAPI
   schema validation with warnings as errors, then the full test suite with coverage and a 95% floor. The frontend
   job lints, type-checks, tests and builds the React app.

2. **Q: Why a matrix of Python versions?**
   **A:** So the code does not accidentally depend on one interpreter. It also exposed a real issue once: a run
   failed on 3.12 only, which led to finding a thread-safety race in how the tests use Celery.

3. **Q: Why `fail-fast: false`?**
   **A:** So one failing version does not cancel the others. Seeing "3.12 failed, 3.13 passed" is information; with
   fail-fast on, the passing run would be cancelled and that evidence lost.

4. **Q: Why run tests against real PostgreSQL and Redis in CI?**
   **A:** The guarantees depend on database features (row locks, partial indexes, constraints), and the
   concurrency tests use real threads. Service containers give a clean, real database for every run.

5. **Q: What is `makemigrations --check` for?**
   **A:** To fail the build if a model change has no migration, which would mean the code expects a database
   structure that deployment will not create.

6. **Q: What does `permissions: contents: read` do?**
   **A:** It gives the workflow token the least access needed, so a compromised step cannot push code or change
   the repository. It is least privilege applied to CI.

7. **Q: How is coverage enforced?**
   **A:** `pytest --cov --cov-fail-under=95` fails the job below 95%. Actual coverage is about 99.4 to 99.5%. The
   floor is never lowered to make a failure pass; coverage is a safety net, not proof of correctness.

8. **Q: How do you run the whole system on your machine?**
   **A:** Create a virtual environment, install requirements, copy `.env.example` to `.env` and set `DATABASE_URL`
   and `REDIS_URL`, create the database, run `migrate`, then start three processes: `runserver`, a Celery worker
   and Celery Beat (plus `npm run dev` for the frontend). In development emails print in the worker terminal.

9. **Q: What differs on Windows?**
   **A:** Redis does not run natively so I use a hosted one over TLS; the worker needs `--pool=solo` because the
   default `prefork` pool does not work, which means one task at a time and no hard time limit, so it is for
   development only; and `.env` must be UTF-8 (PowerShell 5.1 writes UTF-16 with `>`), which the app detects with
   a helpful error. I would also say these Windows steps were walked through but not executed on Windows.

10. **Q: What is missing from your pipeline?**
    **A:** Deployment. CI checks the code but nothing deploys it, there is no staging environment, no dependency
    vulnerability scan and no browser end-to-end tests in CI. I would add those, starting with a dependency
    audit and a deployment job behind manual approval.

## Common mistakes to avoid

* **Forgetting Beat.** The worker alone sends nothing without something that schedules tasks.
* **Running the worker without `--pool=solo` on Windows**, then wondering why tasks never run.
* **Committing a real `.env`**, or reusing the development database role anywhere reachable from a network.
* **Setting `fail-fast: true` on a matrix** and losing the passing runs that explain a failure.
* **Giving CI more permissions than it needs.**
* **Lowering the coverage floor** to make CI green. Fix the cause instead.
* **Skipping the migrations-in-sync check.** It is a cheap way to avoid a broken deployment.
* **Believing CI equals deployment.** Say what is and is not automated.
* **Running CI-only credentials outside CI.** The CI database password is a throwaway for that job.

# 12. Security, privacy and configuration

This is the "how do you protect people and the system" chapter. Chapter 04 covered who may do what
(authentication and permissions). Here we cover the **supporting defences**: rate limiting, logging that
protects privacy, the secret key rules, CORS, configuration through environment variables, and the way of
thinking that suits health data.

## 1. First principles

### Defence in depth

No single protection is perfect, so we stack independent ones: a rate limit slows guessing, hashing protects
stolen data, short-lived tokens limit leaks, database constraints stop corruption. If one layer fails, the next
still holds. When you describe this project, say "layers", not "a magic fix".

### Health-tech privacy thinking

Medication data reveals diagnoses. Someone taking insulin or an antidepressant has told you something very
private just by using the app. Four principles guide the design, and each appears in real code:

| Principle | Meaning | Where it shows up |
|---|---|---|
| **Consent** | Only the patient decides who sees their data | Access grants, revocation (chapter 09) |
| **Least exposure** | Reveal as little as possible, even to attackers | 404 instead of 403, identical invite replies, generic login error |
| **Data minimisation** | Keep and log only what is needed | Logs hold ids and counts, never names or emails (section 3) |
| **Accountability** | Be able to answer "who saw it?" | Audit log written before data is returned (chapter 09) |

### Twelve-factor configuration

Code is the same everywhere; **configuration** (database address, secrets, switches) differs per environment and
comes from **environment variables**, never from files committed to git. This keeps secrets out of the
repository and lets one build run in development, CI and production.

## 2. Rate limiting

A **rate limit** caps how many requests one client may make per period. It slows password guessing, mass
sign-ups and abuse of endpoints that send things. Chapter 04 introduced the five throttles; this section covers
the design.

*From `config/settings.py`, `RATE_LIMITS`:*

```python
RATE_LIMITS = {
    "login": os.environ.get("RATE_LIMIT_LOGIN", "10/min"),  # per client address
    "login_account": os.environ.get("RATE_LIMIT_LOGIN_ACCOUNT", "5/min"),  # per email address
    "register": os.environ.get("RATE_LIMIT_REGISTER", "20/hour"),  # per client address
    "invite": os.environ.get("RATE_LIMIT_INVITE", "20/hour"),  # per patient
    "dose_link": os.environ.get("RATE_LIMIT_DOSE_LINK", "30/min"),  # per client address
}
for _scope, _rate in RATE_LIMITS.items():
    validate_rate(f"RATE_LIMIT_{_scope.upper()}", _rate)
```

Design points:

* **Configurable and validated at startup.** A rate such as `10/fortnight` stops the server with a clear message
  (verified: `RATE_LIMIT_LOGIN must look like '10/min' (sec, min, hour, day), got '10/fortnight'`).
* **Two login limits.** One per client address stops one machine trying many accounts; one per **account** stops
  many machines attacking one account. The account key is a **hash** of the email, so no address is stored in
  Redis (`test_counters_hold_no_email_addresses` checks no cache key contains `@`).
* **Counters live in Redis**, shared by all web processes. Without that, each process would count separately and
  the real limit would be multiplied.
* **Spoofing.** A client can send a fake `X-Forwarded-For` header to look like many addresses. The setting
  `NUM_PROXIES` (default 0) tells DRF to trust only the real socket address, so the header cannot dodge the
  limit (`test_spoofed_forwarded_for_header_does_not_dodge_the_limit`: with a 2-per-minute limit, three requests
  with three different fake headers still give `[401, 401, 429]`). Behind real reverse proxies you set
  `NUM_PROXIES` to their count.
* **It fails open.** Rate limiting must not turn a cache outage into a login outage:

*From `config/ratelimit.py`, `ConfiguredThrottle`:*

```python
class ConfiguredThrottle(SimpleRateThrottle):
    """Base class: the rate comes from settings.RATE_LIMITS[scope], fail-open on cache errors."""

    scope = ""

    def get_rate(self):
        return settings.RATE_LIMITS[self.scope]

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except (RedisError, OSError) as exc:
            log_event(logger, "ratelimit.cache_unavailable", logging.ERROR,
                      scope=self.scope, error_type=type(exc).__name__)
            return True
```

If Redis is unreachable the request is **allowed** and an error is logged
(`test_redis_outage_does_not_block_login_and_is_logged`). The trade-off is stated in the module docstring: the
counting is approximate under heavy concurrency, so these are **abuse limits, not exact quotas**.

* **The dose link limit runs before the token is checked** (chapter 08), so guessing links is cut off first
  (`test_dose_link_limit_applies_before_the_token_is_checked`).
* **Over the limit** the API answers `429` with `Retry-After` (I saw `Retry-After: 60`).

## 3. Structured logging that avoids personal data

### Why "structured"?

A normal log line is a sentence ("sent reminder to bob@x.com for Metformin") which is hard to search and leaks
data. A **structured** log line is an **event name plus key/value fields** (`event=reminder.sent log_id=9
dose_id=337`). Machines can filter and count them; people can read them.

*From `config/logging_utils.py`, module docstring:*

```python
"""Structured logging: one event name plus key/value fields per log line.

Usage::

    log_event(logger, "reminder.sent", log_id=7, dose_id=3, attempt=1)

The formatter prints either one JSON object per line (LOG_FORMAT=json, for
log aggregation) or a readable ``event key=value`` line (LOG_FORMAT=plain).

PRIVACY: log identifiers and counts only. Never put emails, phone numbers,
tokens, medication names or exception messages (which can echo an address)
into fields.
"""
```

*From `config/logging_utils.py`, `log_event`:*

```python
def log_event(logger: logging.Logger, event: str, level: int = logging.INFO, **fields) -> None:
    """Emit one structured event. ``fields`` must be JSON-friendly scalars."""
    logger.log(level, event, extra={"event": event, "fields": fields})
```

Settings choose the format: `LOG_FORMAT` (`plain` or `json`) and `LOG_LEVEL`, validated at startup.

### Proof: the exception message had an email in it, the log did not

I ran the reminder pipeline with an email provider that fails with an error message **containing the patient's
address**, and with `LOG_FORMAT=json`. The log lines (real output):

```json
{"ts":"2026-11-26T08:01:39.520+00:00","level":"INFO","logger":"notifications.services","event":"reminder.claimed","log_id":9,"dose_id":337,"channel":"email","lateness_s":0}
{"ts":"2026-11-26T08:01:39.688+00:00","level":"WARNING","logger":"notifications.services","event":"reminder.retry_scheduled","log_id":9,"dose_id":337,"channel":"email","attempt":1,"error_type":"ConnectionError","retry_at":"2026-11-26T08:02:39.520962+00:00"}
{"ts":"2026-11-26T08:01:39.694+00:00","level":"INFO","logger":"notifications.services","event":"reminder.retry_due","log_id":9,"dose_id":337,"channel":"email","attempts":1}
```

The failing call raised `ConnectionError("cannot reach smtp for logdemo.private@example.com")`, yet the log has
only `error_type=ConnectionError`. I searched the whole log output for the email, the patient's name and the
medication name: **0 matches**. The code that does this is a single line, quoted in chapter 07:
`error_type=type(exc).__name__`. The rule is enforced by a test:

* `test_logs_never_contain_personal_data_or_error_messages` runs a failing and a recovered send, renders every
  `notifications` log record as JSON and asserts it contains none of: the patient's email, the medication name,
  the dosage, the SMTP error text, or the `dose-reminder-` idempotency key.

**An honest nuance:** the `NotificationLog.error` *database column* does store `"ConnectionError: <message>"`
(`_record_failure`: `f"{type(exc).__name__}: {exc}"[:1000]`) so an operator can diagnose. That text can echo an
address, and it lives in the database (which is access controlled) rather than in the logs (which are often
shipped to third-party tools). If you must tighten it further, redact there too. Being able to point at exactly
where personal data can and cannot appear is the real skill.

Other logging habits: events are named `area.what` (`reminder.sent`, `ratelimit.cache_unavailable`,
`dose.marked_missed`); quiet minutes stay quiet (`reminder.dispatch` logs only when it did something); levels
carry meaning (a recovery is a WARNING, giving up is an ERROR). The full list of reminder events is in chapter 07.

## 4. The secret key

`SECRET_KEY` signs two things here: **JWTs** (chapter 04) and the **one-click dose links** (chapter 08). If someone
learns it, they can forge both. So the rules are strict:

*From `config/settings.py`:*

```python
_DEV_SECRET_KEY = "dev-only-insecure-key-change-me-not-for-production-use"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", _DEV_SECRET_KEY)

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = env_bool("DJANGO_DEBUG", True)

ALLOWED_HOSTS = [h for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h]
```

*From `config/env.py`, `validate_secret_key`:*

```python
def validate_secret_key(secret_key: str, *, debug: bool, dev_key: str) -> None:
    """Outside debug mode, refuse the built-in dev key, placeholders and short keys.

    Dose links and JWTs are signed with this key, so a guessable key means forgeable links and tokens.
    """
    if debug:
        return
    if secret_key == dev_key or secret_key.lower().startswith("change-me") or len(secret_key) < 32:
        raise ImproperlyConfigured(
            "Set DJANGO_SECRET_KEY to a long random value (at least 32 characters) when DJANGO_DEBUG is not "
            "true. Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(50))\""
        )
```

* In **debug** mode (development) the built-in key is allowed so a new developer can start immediately.
* **Outside debug**, the server **refuses to start** with the dev key, a placeholder starting with `change-me`,
  or any key shorter than 32 characters.

I ran `manage.py check` with debug off:

```text
no key set          -> ImproperlyConfigured: Set DJANGO_SECRET_KEY to a long random value (at least 32 characters) ...
key "short"         -> the same error
key "change-me-..." -> the same error
a generated 50-character key -> System check identified no issues (0 silenced).
```

`.env.example` ships no short placeholder secret key (a commit in the project history fixed exactly that: "Do not
ship a short placeholder secret key in .env.example"). Note also that **`DEBUG` defaults to true** in
`settings.py` for convenience, so a deployment must set `DJANGO_DEBUG=false`; the secret-key check then forces a
real key, which is a good safety net.

## 5. CORS (and why it is not a security feature of the server)

**The problem.** Browsers enforce the *same-origin policy*: a web page from `http://localhost:5173` may not read
responses from `http://localhost:8000` unless the server says so with **CORS** headers. CORS protects *users'
browsers* from other websites; it does not stop curl or a script from calling the API (that is what
authentication is for).

*From `config/settings.py`:*

```python
CORS_ALLOWED_ORIGINS = env_origins("CORS_ALLOWED_ORIGINS")
CORS_URLS_REGEX = r"^/api/.*$"
# Lets the frontend read how long to wait after a 429.
CORS_EXPOSE_HEADERS = ["Retry-After"]
```

Choices and the reasons:

* **Closed by default.** `CORS_ALLOWED_ORIGINS` defaults to an empty list: no website may read API responses.
* **An allow-list, never `*`.** `env_origins` rejects wildcards, paths and missing schemes **at startup**
  (verified: `CORS_ALLOWED_ORIGINS must be comma-separated origins such as https://app.example.com ... got '*'`).
* **No credentials.** The API uses a bearer token in a header, not cookies, so `CORS_ALLOW_CREDENTIALS` stays
  false and no `Access-Control-Allow-Credentials` header is sent.
* **Only `/api/`** is exposed (`CORS_URLS_REGEX`); `/health/`, the admin and the dose link are not.
* **`Retry-After` is exposed** so the frontend can show "please wait 30 seconds" after a 429.

Real responses (Django's test client, with `CORS_ALLOWED_ORIGINS=http://localhost:5173`):

```text
preflight from http://localhost:5173   -> 200 Allow-Origin='http://localhost:5173' Allow-Headers='accept, authorization, content-type, ...' Credentials=None
preflight from http://evil.example.com -> 200 Allow-Origin=None Allow-Headers=None
/health/ with an allowed origin        -> Allow-Origin: None
/api/me/ 401 is still readable         -> status 401 Allow-Origin: http://localhost:5173 | Expose: Retry-After
default (variable unset)               -> no origin gets any permission
```

(`tests/test_cors.py`, for example `test_never_a_wildcard_and_never_credentials`, `test_only_the_api_is_exposed`,
`test_an_unauthenticated_401_is_readable_by_the_frontend`.)

## 6. Configuration through environment variables

### The rules

1. **No secrets in code.** Everything configurable is read from the environment (`os.environ`), through helpers
   in `config/env.py`.
2. **`.env` is git-ignored; `.env.example` is committed with placeholders.** `.gitignore` lists `.env`, and a test
   asserts it (`test_env_files_are_ignored_by_git`).
3. **Real environment variables beat the `.env` file** (`test_real_environment_variables_beat_the_env_file`).
4. **Fail loudly at startup.** Bad or missing settings stop the server with a message that says what to fix.

I triggered each failure for real:

```text
no DATABASE_URL            -> Missing required environment variable DATABASE_URL. Copy .env.example to .env and set DATABASE_URL (see README).
CORS_ALLOWED_ORIGINS='*'   -> CORS_ALLOWED_ORIGINS must be comma-separated origins such as https://app.example.com ... got '*'.
RATE_LIMIT_LOGIN=10/fortnight -> RATE_LIMIT_LOGIN must look like '10/min' (sec, min, hour, day), got '10/fortnight'.
REMINDER_SENDING_TIMEOUT_SECONDS=30 -> REMINDER_SENDING_TIMEOUT_SECONDS must be at least 2 x (EMAIL_TIMEOUT + 30).
REMINDER_GRACE_MINUTES=200 -> REMINDER_GRACE_MINUTES must be smaller than DOSE_MISSED_AFTER_MINUTES.
```

The last two protect the reminder guarantee (chapter 07): they enforce the relationships between settings that the
design depends on.

### A test that keeps the documentation honest

`tests/test_configuration.py` scans every Python file for environment variables the code reads (with a regular
expression for `os.environ.get`, `env_int`, `env_bool`, `env_list`, `env_origins`, `require_env`) and asserts:

* every variable is listed in `.env.example` **and** in `README.md`;
* `.env.example` lists no variable the code never reads;
* `.env.example` holds only placeholders (it contains `DB_PASSWORD` and `smtp-password-placeholder`, and no
  patterns like `sk_live`, `AKIA...` or `-----BEGIN`);
* a weak secret key is rejected outside debug mode, a strong one accepted, and debug accepts anything;
* a `.env` saved as UTF-16 by Windows PowerShell gives a helpful error instead of a confusing crash
  (`load_env_file`, `test_utf16_env_file_from_powershell_gets_a_helpful_error`).

So adding a setting without documenting it **fails the test suite**.

## 7. Other protections in the code

* **The health endpoint never leaks.** `GET /health/` reports `database` and `redis` as `"ok"` or
  `"error: <ExceptionClassName>"` with status 503, never the message, which could contain a hostname
  (`test_redis_down_is_reported_as_503_without_leaking_details` raises an error mentioning `secret-host` and
  asserts it never appears).
* **Passwords:** PBKDF2 hashing and four validators (chapter 04); a generic login error.
* **Mass assignment is blocked:** ownership and status fields are read-only in serializers (chapter 05).
* **Existence is hidden:** 404 for resources you may not see; identical invitation replies (chapter 09).
* **Signed, expiring, throttled links** with no-store, no-referrer and noindex headers (chapter 08).
* **Notification channels are stubs for SMS/WhatsApp.** `CLAUDE.md` forbids sending real messages; the stub
  classes only log an idempotency key (`notifications/channels.py`).
* **Demo credentials are public and dev-only.** `seed_demo` refuses to run unless `DJANGO_DEBUG=true`.

## 8. What this project does *not* protect (say it out loud)

A strong answer includes limits (chapter 16 has the full list):

* No email verification, password reset or account deletion; refresh tokens are not rotated or revoked.
* Reminder emails contain the **medication name and dose** in the subject and body, sent over normal email. That
  is a privacy trade-off of using email as the channel; a stricter design would send a neutral "time for your
  medicine" message with a link.
* Rate limiting is approximate and fails open.
* The database `error` column may contain provider error text.
* `DEBUG` defaults to true, so production needs `DJANGO_DEBUG=false`.

## 9. Try it yourself

```bash
pytest tests/test_ratelimit.py tests/test_cors.py tests/test_configuration.py tests/test_settings_validation.py tests/test_health.py -v
```

Then break a setting on purpose (`RATE_LIMIT_LOGIN=oops python manage.py check`) and read the message.

## Interview questions on this chapter

1. **Q: How do you protect login against brute force?**
   **A:** Password hashing makes each guess expensive on the attacker's side of a stolen database, and online
   guessing is rate limited twice: per client address (10 a minute) and per account (5 a minute, keyed by a hash of
   the email). Over the limit the API returns 429 with `Retry-After`. Counters live in Redis so all web processes
   share them.

2. **Q: Your rate limiter fails open. Why, and what is the risk?**
   **A:** If Redis is down I do not want a cache outage to become a login outage, so requests are allowed and the
   error is logged. The risk is that during an outage there is no throttling; and the counting is approximate even
   when Redis works. These are abuse limits, not exact quotas, and I document that.

3. **Q: Can a client dodge the rate limit with a fake `X-Forwarded-For` header?**
   **A:** Not by default: `NUM_PROXIES` is 0, so only the socket address counts. Behind real proxies you set it to
   the number of proxies so the right hop is trusted. A test sends three different fake headers against a
   2-per-minute limit and still gets a 429.

4. **Q: How do you keep personal data out of logs?**
   **A:** Logs are structured events with only identifiers and counts, and the module docstring forbids emails,
   phone numbers, tokens, medication names and exception messages. For failures I log the exception class, not
   its text. I tested it: an error message containing the patient's email produced a log with only
   `error_type`, and a test asserts no personal data appears.

5. **Q: What is the secret key used for here and how is it protected?**
   **A:** It signs JWTs and the one-click link tokens, so leaking it allows forgery. Outside debug mode the app
   refuses to start with the default key, a `change-me` placeholder or anything under 32 characters, and it is
   only ever read from an environment variable.

6. **Q: What is CORS and how did you configure it?**
   **A:** A browser rule that blocks a page from reading responses of another origin unless the server allows
   it. It is closed by default; allowed origins come from an environment variable, are validated at startup (no
   wildcard, no path), only `/api/` is exposed, credentials are not allowed because I use a bearer header, and
   `Retry-After` is exposed. CORS does not protect the API from non-browser clients; authentication does.

7. **Q: Why does the app crash at startup on a bad setting instead of continuing?**
   **A:** A misconfigured system that "mostly works" can silently weaken guarantees, like a reminder lease shorter
   than the send time. Failing at startup with a clear message surfaces it immediately and cheaply, and tests
   start the app with bad settings to prove it.

8. **Q: How do you stop secrets being committed?**
   **A:** `.env` is git-ignored and only `.env.example` with placeholders is committed. A test asserts `.env` is
   ignored, that the example holds only placeholders, and that every variable the code reads is documented.

9. **Q: What privacy risks remain in a reminder app?**
   **A:** Emails include the medication name and dose, so the content passes through email systems. The
   `error` column can hold provider text. There is no email verification. I would reduce the email content to a
   neutral message with a link, redact stored errors, and add verification.

10. **Q: How does the health endpoint avoid information leaks?**
    **A:** It reports only `ok` or `error: <ExceptionClassName>` for the database and Redis, never the exception
    message, which could include hostnames. A test raises an error mentioning a secret host and asserts it does not
    appear.

## Common mistakes to avoid

* **Logging whatever is convenient** (emails, tokens, request bodies, exception messages). Decide what may be
  logged and enforce it with a test.
* **Treating CORS as authentication.** It only governs browsers.
* **Using `*` for allowed origins** or allowing credentials without need.
* **Committing a real `.env`** or putting a real secret in `.env.example`.
* **Letting production run with debug on or the default secret key.**
* **Trusting `X-Forwarded-For` blindly.** Only trust the number of proxies you really have.
* **Assuming the rate limit is exact.** Say it is approximate and fail-open by design.
* **Different error messages for "unknown email" and "wrong password".** That lets attackers enumerate accounts.
* **Documenting configuration by hand and letting it drift.** Test it, as this project does.

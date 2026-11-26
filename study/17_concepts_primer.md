# 17. Concepts primer: the ideas behind the code

This chapter is a glossary you can read in one sitting. Every concept gets three parts: what it is in plain words, why anyone needs it, and one small example taken from this project. If a word in another chapter confused you, come here first, then go back.

Chapters that use each idea in depth are named at the end of each section.

---

## 1. HTTP and REST

**Plain words.** HTTP is the language a client (a browser, the React app, a phone) uses to talk to a server. The client sends a *request* (a method, a path, headers, sometimes a body) and the server sends back a *response* (a status code, headers, a body). REST is a habit for designing those requests: every thing the system knows about (a medication, a dose) has an address (a URL), and the method says what you want to do with it.

| Method | Meaning | Safe to repeat? |
|---|---|---|
| GET | read | yes, changes nothing |
| POST | create or perform an action | no, unless you design it so |
| PUT / PATCH | replace / partly change | yes for PUT |
| DELETE | remove | yes |

Status codes are grouped: 2xx worked, 4xx the client did something wrong, 5xx the server broke. The ones this project uses on purpose: 200, 201, 202 (accepted, used by the invite endpoint), 400, 401 (not logged in), 404, 409 (conflict), 410 (gone, expired link), 429 (too many requests).

**Project example.** Taking a dose is `POST` on a dose URL. If the dose is in a state where it cannot be taken, the server answers 409 Conflict rather than 400, because the request itself was fine but it clashes with the current state of the resource. The link in the reminder email is deliberately different: opening it with GET only shows a page, and only a POST button press changes data, because email scanners and previews fetch links with GET and must not take your dose for you.

See chapters 4, 8.

---

## 2. ORM

**Plain words.** An ORM (object-relational mapper) lets you write Python classes instead of SQL. A class is a table, an attribute is a column, an instance is a row. Django's ORM turns `DoseEvent.objects.filter(status="pending")` into a `SELECT ... WHERE status = 'pending'`.

**Why.** Less repetitive SQL, protection against SQL injection (values are sent as parameters, never pasted into the text), and the same code works on different databases.

**Where it hurts.** The ORM hides what runs. A loop that touches a related object on each row triggers one query per row (the "N+1" problem). The reports app avoids this by asking the database to count for you in one query using conditional aggregation.

**Project example.** The ORM can still express advanced database features. The reminder claim in `notifications/services.py` uses row locking straight from Python:

*From `notifications/services.py`, `claim_due_doses`:*

```python
    with transaction.atomic():
        doses = list(
            DoseEvent.objects.select_for_update(skip_locked=True, of=("self",))
            .filter(
                status=DoseStatus.PENDING,
                scheduled_at__gte=now - conf.grace(),
                scheduled_at__lte=now + conf.lead(),
```

See chapters 3, 5, 10.

---

## 3. Migrations

**Plain words.** A migration is a numbered file that describes one change to the database structure (add a column, add an index). Django compares your models with the migration history and writes the file for you (`makemigrations`); `migrate` applies the files that have not run yet. The history is a version control system for the schema.

**Why.** Every environment (your laptop, CI, production) reaches the same schema by replaying the same steps in order. You never edit a deployed database by hand.

**Project example.** CI runs `python manage.py makemigrations --check`. If you change a model but forget to commit the migration, that step fails. The performance work created its indexes with `AddIndexConcurrently`, which builds an index without blocking writes, and created the new index before dropping the old one so queries never lacked an index.

See chapters 3, 11, 14.

---

## 4. Serializers and viewsets

**Plain words.** A *serializer* converts between Python objects and JSON, and validates incoming data ("is this a real timezone name?"). A *view* receives a request and returns a response. A *viewset* bundles the usual operations (list, create, retrieve, update, delete) for one resource into a single class, and a *router* generates the URLs for it.

**Why.** Validation lives in one place, outside the views, and the API documentation (drf-spectacular) is generated from the same classes.

**Project example.** The medication endpoints are a viewset in `medications/views.py`; the serializer rejects bad input before any database write. Permission classes decide who may call each view, and the caregiver data views additionally ask the database each request whether the grant still exists.

See chapters 4, 5, 9.

---

## 5. Transactions

**Plain words.** A transaction groups several database steps so that they either all happen or none of them do. If something fails halfway, the database rolls back to how it was. This is the "A" (atomic) in ACID.

**Project example.** Claiming a reminder does two things: flip the dose from `pending` to `reminded`, and insert a `NotificationLog` row with status `sending`. They are inside one `transaction.atomic()` block. Without that, a crash between the two steps would leave a dose that is marked reminded but has no log, and nobody would ever send it: a missed reminder. One more rule of this project: the actual email is **never** sent inside a transaction, because a slow mail server would hold database locks open.

See chapter 7.

---

## 6. Row locks

**Plain words.** When two workers read the same row at the same time, both may decide to act on it. A *row lock* (`SELECT ... FOR UPDATE`) makes the second worker wait until the first finishes. `SKIP LOCKED` goes further: the second worker simply ignores rows that are locked and takes other ones.

**Why.** Several workers can share a queue stored in a table, without a separate queueing product, and without ever grabbing the same item twice.

**Project example.** `claim_due_doses` (snippet above) uses `skip_locked=True`. If two Celery workers run it at the same moment, they receive disjoint sets of doses. Chapter 7 shows a test that runs two real threads against the real database to prove it.

See chapters 7, 13.

---

## 7. Idempotency

**Plain words.** An operation is idempotent if doing it twice has the same effect as doing it once. Setting a light switch to "on" is idempotent; "toggle" is not. Networks and workers fail and retry, so anything that may run twice must be safe to run twice.

**Two tools in this project:**

1. A **unique constraint** in the database. `DoseEvent` has UNIQUE(schedule, scheduled_at), and `NotificationLog` has UNIQUE(dose_event, channel). Even buggy code cannot insert a duplicate.
2. **Conflict-ignoring inserts.** Dose generation inserts with `ignore_conflicts=True`, so running the daily job twice creates nothing the second time.

*From `scheduling/services.py`, `generate_dose_events`:*

```python
    DoseEvent.objects.bulk_create(new, ignore_conflicts=True)
    return len(new)
```

Taking a dose that is already taken is also idempotent: the API returns the unchanged dose instead of an error.

See chapters 6, 7, 8.

---

## 8. At-least-once versus at-most-once delivery

**Plain words.** When a message might get lost or the sender might crash after sending but before writing it down, you must choose:

- **At-most-once:** send once, never retry. No duplicates, but messages can be lost.
- **At-least-once:** retry until you are sure it was sent. Nothing is lost, but duplicates are possible.
- **Exactly-once:** both properties. It cannot be fully guaranteed across two separate systems (your database and an email server), so real systems fake it with at-least-once plus idempotent receivers.

**Project choice.** For medication, a missed reminder is worse than a repeated one, so the pipeline is at-least-once with one narrow duplicate window: the mail provider accepted the message, but the worker died before writing `sent`. Resends reuse the same Message-ID, so many mail systems recognise the duplicate. The project documents this honestly instead of claiming exactly-once.

See chapter 7, 16.

---

## 9. Message queues and brokers

**Plain words.** A *queue* is a line of jobs. A *producer* adds jobs; a *consumer* (worker) takes them off and runs them, usually in a different process or machine. A *broker* is the server that holds the line while jobs wait. This decouples "something must happen" from "do it now, in the web request".

**Project example.** Sending an email can take seconds and can fail, so it never happens inside a web request or inside the minute-by-minute sweep itself. The sweep claims due doses and enqueues one `deliver_notification` job per reminder (`notifications/tasks.py`); a worker picks each job up. Redis is the broker (`REDIS_URL`).

See chapters 2, 7.

---

## 10. Celery and Celery Beat

**Plain words.** Celery is the Python library that defines jobs (tasks) and runs workers that consume them from the broker. Celery Beat is a separate process that is only a clock: at scheduled times it puts tasks on the queue. Beat does not run the work; workers do.

**Project example.** The beat schedule in `config/settings.py` triggers the daily `generate_upcoming_doses` job at 00:10 UTC and the reminder sweep every minute. Tasks are written to be safe if they run twice or overlap, because a clock plus retries can easily cause that.

**Gotcha you saw in this project.** In tests Celery can run "eagerly" (inline). A race in that mode caused a flaky CI failure on Python 3.12; chapter 13 tells the story.

See chapters 2, 7, 13.

---

## 11. JWT

**Plain words.** A JSON Web Token is a signed string the server gives you after login. It contains claims (who you are, when it expires) and a signature made with a secret key. On later requests you send it back in the `Authorization: Bearer ...` header. The server checks the signature instead of looking up a session, so it needs no session storage.

**Settings here.** Access token 30 minutes, refresh token 7 days (`SIMPLE_JWT` in `config/settings.py`). Short access tokens limit the damage of a leak; the refresh token gets a new one without asking for the password.

*From `config/settings.py`:*

```python
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
}
```

**Important limits, stated honestly.** A JWT cannot be revoked before it expires without extra machinery, and this project has no blacklist or server-side logout. The `role` claim is informational: permissions read the role from the database on every request, so a stale token cannot keep an old role.

See chapter 4, 12.

---

## 12. CORS

**Plain words.** Browsers forbid a page from one origin (say `http://localhost:5173`) reading responses from another (`http://localhost:8000`) unless the server says it is allowed. CORS is that "allowed" header. It is enforced by the **browser** only; curl ignores it. It is not a security wall against attackers, it is a rule that protects users' browsers.

**Project rule.** Allowed origins come from the `CORS_ALLOWED_ORIGINS` environment variable, apply only under `/api/`, and credentials (cookies) are not allowed, because tokens travel in a header. `Retry-After` is exposed so the frontend can read rate-limit waits.

See chapters 12, 15.

---

## 13. Rate limiting

**Plain words.** Cap how many requests a caller may make in a time window, so passwords cannot be guessed by brute force and one client cannot flood the service. Exceeding it returns 429.

**Project example.** Login: 10 per minute per IP plus 5 per minute per account (the email is hashed in the cache key, so it is not stored in plain text). Register: 20 per hour. The dose link: 30 per minute. The counters live in Redis. If Redis is down, the throttle *fails open* (allows the request) and logs an error, because making login impossible whenever the cache is down would be a worse outcome than briefly losing the limit:

*From `config/ratelimit.py`:*

```python
    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except (RedisError, OSError) as exc:
            log_event(logger, "ratelimit.cache_unavailable", logging.ERROR,
                      scope=self.scope, error_type=type(exc).__name__)
            return True
```

See chapter 12.

---

## 14. Indexes: ordinary, partial and covering

**Plain words.** An index is a sorted side structure that lets the database find rows without reading the whole table, like a book index. It costs disk space and slows writes a little, so you add it only for queries that need it.

- **Partial index:** indexes only the rows matching a condition. `dose_open_idx` covers only pending and reminded doses, so it is 240 kB instead of the 7.3 MB of the old whole-history index.
- **Covering index:** includes extra columns so the database can answer from the index alone without visiting the table (an "index-only scan"). `dose_patient_cover_idx` lets the report count statuses from the index.

**Measured effect (chapter 11).** Idle reminder claim: 4.25 ms and 4,032 buffers became 0.28 ms and 18 buffers. A 90-day report: 1.18 ms/277 buffers became 0.15 ms/9.

See chapter 11.

---

## 15. EXPLAIN

**Plain words.** `EXPLAIN ANALYZE <query>` asks PostgreSQL to run the query and describe how: which indexes it used, how many rows it expected versus found, how long each step took, and (with `BUFFERS`) how many 8 kB pages it touched. Buffers are a more stable measure than milliseconds, because time depends on caches and noise.

**Reading it.** `Seq Scan` means the whole table was read. `Index Scan` / `Index Only Scan` means an index was used. A big gap between estimated and actual rows means the statistics are stale (run `ANALYZE`).

**Project note.** The planner picks plans based on statistics, so a test that asserts a specific plan can pass or fail depending on table size. That caused a flaky index test, fixed by building the test around tables where the choice is stable and adding negative controls (chapter 13).

See chapters 11, 13.

---

## 16. UTC

**Plain words.** UTC is the world's reference clock, with no daylight saving. Storing every instant in UTC means a stored value is one unambiguous moment. You convert to a local time only when you *display* it or when you *interpret user intent*.

**Project example.** `DoseEvent.scheduled_at` and every other timestamp is stored in UTC (Django `USE_TZ = True`). Code uses `timezone.now()`, never naive `datetime.now()`.

---

## 17. IANA timezones and daylight saving

**Plain words.** A timezone like `Asia/Kolkata` is an IANA name: a rulebook of UTC offsets and when they change. A fixed offset such as "+05:30" is not enough, because New York is -05:00 in winter and -04:00 in summer. Python's `zoneinfo` reads the rulebook.

**The problem.** "Take at 08:00" means 08:00 *on the patient's wall clock*. The UTC time of that changes twice a year for a New York patient, so you cannot compute it once and repeat every 24 hours. Store the wall-clock time, and convert **per date** when generating doses.

**The two awkward days.**

- Spring forward: 02:30 does not exist. This project shifts the dose forward to 03:30.
- Fall back: 01:30 happens twice. This project uses the first occurrence.

Both come from building the datetime with `fold=0`; the function is `local_to_utc` in `scheduling/services.py`. Chapter 6 walks through it with real numbers.

---

## 18. pytest fixtures

**Plain words.** A fixture is a reusable piece of test setup. A test lists the fixtures it needs as arguments, and pytest builds them and passes them in; they can depend on one another. This replaces long copy-pasted setup.

**Project example.** The root `conftest.py` defines `patient`, `other_patient`, `patient_api` (an authenticated test client) and similar. A test needing a logged-in patient just writes `def test_x(patient_api): ...`.

*From `conftest.py`:*

```python
@pytest.fixture
def patient(db):
    return make_user("patient@example.com")
```

The `db` argument gives the test a database that is rolled back afterwards. Tests that need real concurrency use `transaction=True`, because a rolled-back wrapper transaction hides commits from other threads.

See chapter 13.

---

## 19. CI (continuous integration)

**Plain words.** A server automatically runs your checks on every push, so a broken change is noticed in minutes, by a machine that is not your laptop, with a clean environment.

**Project example.** `.github/workflows/tests.yml` starts PostgreSQL 16 and Redis 7 services, then runs `manage.py check`, `makemigrations --check`, the OpenAPI schema validation, and pytest with a 95 percent coverage floor, on Python 3.12 and 3.13. A separate frontend job runs lint, type check, tests and build. The Python 3.12 flake in this project was found by exactly this matrix.

See chapter 14.

---

## Interview questions on this chapter

1. **Q: Why does the project answer 409 instead of 400 when a dose cannot be taken?**
   **A:** The request was well formed, so it is not a 400. It conflicts with the current state of the resource (the dose is in a state that does not allow the action), which is exactly what 409 Conflict means. A distinct code lets the frontend show a specific message and refresh the dose.

2. **Q: What is the difference between a transaction and a row lock?**
   **A:** A transaction makes a group of steps all-or-nothing. A row lock stops other transactions from changing, or in the `SKIP LOCKED` case from claiming, the same rows at the same time. They are used together: lock the rows inside the transaction, and the lock is released when it ends.

3. **Q: Explain idempotency with one example from this project.**
   **A:** Dose generation inserts with `ignore_conflicts=True` on top of a unique constraint on (schedule, scheduled_at). Running the daily job twice, or two workers at once, creates each dose once. The constraint is the real guarantee, because it holds even if application code has a bug.

4. **Q: Why not use exactly-once delivery?**
   **A:** It cannot be guaranteed between two independent systems, because a crash can happen after the email provider accepts a message but before the database records it. The project chooses at-least-once so no reminder is lost, reuses the Message-ID so a duplicate is recognisable, and documents the narrow window.

5. **Q: What does Celery Beat do that a worker does not?**
   **A:** Beat only schedules: it enqueues tasks at configured times. Workers consume the queue and execute the tasks. You need at least one of each, and tasks must tolerate overlap or repeats.

6. **Q: Why are the access tokens short-lived?**
   **A:** A signed token cannot be recalled before it expires, so a short lifetime (30 minutes) limits what a stolen token can do. The refresh token (7 days) lets the user stay signed in without storing the password.

7. **Q: Is CORS a security feature that protects the API?**
   **A:** No. It is a browser rule that stops one site's JavaScript from reading another site's responses without permission. Attackers using curl ignore it. Real protection is authentication, authorisation and validation on the server.

8. **Q: What is a partial index and where does this project use one?**
   **A:** An index over only the rows that satisfy a condition. The open-doses index covers only doses still pending, which is a tiny fraction of the table, so the frequent reminder query reads 18 buffers instead of 4,032 and the index is 240 kB.

9. **Q: Why store wall-clock times and not UTC times in the schedule?**
   **A:** The patient means "08:00 where I live", and the UTC equivalent changes with daylight saving. Storing local time and converting per date keeps the dose at 08:00 local all year. Only the generated dose instants are stored in UTC.

10. **Q: What does `EXPLAIN (ANALYZE, BUFFERS)` tell you that a stopwatch does not?**
   **A:** Which plan the database chose, how its row estimates compared with reality, and how many pages it touched. Page counts are stable between runs while timings are noisy, which makes them better evidence for a before-and-after comparison.

## Common mistakes to avoid

- Saying "REST" means "uses JSON". It is a way of modelling resources and using HTTP methods and codes consistently.
- Believing a JWT can be logged out server-side. Without a blacklist it cannot; say so.
- Calling CORS a firewall.
- Claiming the system is "exactly-once". It is at-least-once with a documented narrow duplicate window.
- Storing times in local time, or computing "every 24 hours" for daily schedules across a daylight saving change.
- Adding an index "for speed" without measuring with EXPLAIN. Indexes cost space and write time.
- Sending an email while holding a database transaction open.
- Testing concurrency with a single thread; it proves nothing about races.

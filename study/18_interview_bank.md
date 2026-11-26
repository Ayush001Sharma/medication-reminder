# 18. Interview bank: 80 questions with model answers

How to use this chapter. Cover the answer, say yours out loud, then compare. The model answers are 3 to 6 sentences: that is the length of a good spoken answer. Do not memorise them word for word; learn the facts and say them in your own voice. Each question has a **Follow-up** an interviewer is likely to ask next, and a short pointer to the chapter that teaches the details.

The questions are in eight groups of ten:

1. The project
2. Django and DRF
3. PostgreSQL
4. Celery and Redis
5. Concurrency and reliability
6. Security and health-tech privacy
7. Testing
8. System design extensions

Whenever an answer admits a limitation, that is on purpose. Interviewers trust candidates who know where their own system is weak.

---

## Group 1: The project

### Q1. Describe your project in 30 seconds.
A backend for medication adherence. Patients add prescriptions with schedules; the system generates dose events, emails reminders at the right local time, and records whether each dose was taken, skipped or missed. Caregivers and doctors can see an adherence report only for patients who granted them access, and every view is audited. It is Django, DRF, PostgreSQL, Celery with Redis, and a React frontend.

**Follow-up:** Who is the user and what hurts if it fails? A patient who misses a dose, so reliability of reminders is the core requirement. (Ch 1)

### Q2. What was the hardest technical problem?
Making reminders never duplicate and never vanish when workers crash, overlap or retry. I solved it with database guarantees instead of timing assumptions: unique constraints, a `FOR UPDATE SKIP LOCKED` claim, a lease token on each send, and recovery of expired leases. The result is at-least-once delivery with one narrow, documented duplicate window.

**Follow-up:** What is that window? The provider accepted the email but the worker died before recording `sent`; the resend reuses the same Message-ID. (Ch 7)

### Q3. Why did you choose this stack?
Django gives migrations, an ORM, an admin and security defaults, DRF gives serializers, permissions and throttling, and PostgreSQL gives constraints, partial indexes and row locking, which the reliability design depends on. Celery and Redis are the standard way to run background and scheduled work in Python. JWT keeps the API stateless for a separate frontend.

**Follow-up:** Would you use something other than Celery? For simple cases a database-backed queue or a managed scheduler could work; I kept Celery because it is the common choice and I could make tasks idempotent. (Ch 2)

### Q4. Walk me through what happens from "patient adds a medication" to "patient gets an email".
Creating a schedule triggers a signal that generates dose events for the next 7 days, each stored in UTC after converting the patient's local times. Every minute a Beat task claims doses due within the window, flips them to `reminded` and creates a log row in one transaction, then enqueues a delivery task per reminder. A worker acquires the lease, sends the email outside any transaction, and records `sent`. The daily job keeps the horizon filled.

**Follow-up:** What if the schedule is edited? Future pending doses are deleted and regenerated; past doses are untouched. (Ch 5 to 7)

### Q5. How do you handle timezones?
Schedules hold local wall-clock times and the patient has an IANA timezone. For each date I build the local datetime with `zoneinfo` and convert to UTC, so a dose at 08:00 stays at 08:00 local across daylight saving. Everything stored is UTC. Nonexistent local times shift forward; ambiguous ones use the first occurrence.

**Follow-up:** Why not store UTC in the schedule? The UTC equivalent changes twice a year, so a fixed UTC time drifts by an hour for the patient. (Ch 6)

### Q6. What does "adherence" mean in your reports?
Taken divided by taken plus missed. Skipped, still-pending and future doses are excluded because they are not failures. If there is no qualifying dose, the percentage is null, not 0, so the UI can say "no data". I also report counts and a streak.

**Follow-up:** Why exclude skipped? A deliberate skip, for example on a doctor's advice, should not be counted as non-adherence; the report shows it separately. (Ch 10)

### Q7. How does a caregiver get access to a patient?
The patient invites an email. The invite response is always the same 202 message, so it does not reveal whether an account exists. Only a user whose email matches can accept, and acceptance happens under a row lock. Every data request then checks the grant in the database, and the patient can revoke at any time.

**Follow-up:** Why 404 and not 403 for no access? A 403 confirms the patient exists; a 404 leaks nothing. (Ch 9)

### Q8. What did you do about performance?
I measured first, on a scratch database with a million doses. Partial and covering indexes and a query rewrite cut the idle reminder claim from 4.25 ms (4,032 buffers) to 0.28 ms (18 buffers) and a 90-day report from 277 to 9 buffers. The new indexes were created concurrently before the old were dropped.

**Follow-up:** Why report buffers, not only milliseconds? Page counts are stable between runs; timings are noisy. (Ch 11)

### Q9. What are the limitations of the project?
No email verification or password reset, refresh tokens are not rotated or blacklisted, caregiver and doctor roles are not verified, there is no deployment pipeline, and workers down for more than an hour mean that reminder is missed. Email is the only real channel; SMS and WhatsApp are interface-ready but deliberately never sent. I would fix account security first.

**Follow-up:** Which would you do first and why? Account security, because it protects health data and affects every user. (Ch 16)

### Q10. How do you know it works?
460 backend tests at about 99.4 percent coverage with a 95 percent CI floor, real-thread concurrency tests against the real database, a Python 3.12 and 3.13 matrix, and 450 frontend tests. I also ran mutation experiments, deliberately breaking the code to confirm that a test fails.

**Follow-up:** Give an example of a mutation. Removing the token check in `_acquire` is caught only by the real-thread test. (Ch 13)

---

## Group 2: Django and DRF

### Q11. What is the difference between a Django project and an app?
A project is the whole site and its configuration (`config/`). An app is a reusable package with models, views and tests for one area. Mine has five: `accounts`, `medications`, `scheduling`, `notifications`, `reports`, each with one responsibility.

**Follow-up:** How did you decide the boundaries? By the nouns of the domain and who changes together. (Ch 2)

### Q12. Why a custom user model?
Django strongly advises setting it at the start, because changing later is painful. I log in by email, not username, and the user carries a role (patient, caregiver, doctor). The profile with the timezone is a separate model.

**Follow-up:** Where is the role checked? In permission classes, using the database value on every request. (Ch 4)

### Q13. What is a serializer and why not validate in the view?
It converts between model instances and JSON and validates input. Putting validation there keeps views thin, makes rules reusable, and lets drf-spectacular generate accurate API docs from the same classes. For example it rejects an invalid IANA timezone before anything is saved.

**Follow-up:** Where do you put rules involving several fields? In the serializer's `validate` method or in the model's constraints, depending on whether the database must enforce it. (Ch 5)

### Q14. How do DRF permissions work in your project?
Permission classes run before the view and decide access, for example only patients may manage their medications. For shared data a helper checks the grant in the database on each request. Denied cases return 404 to avoid confirming existence.

**Follow-up:** Why check each request instead of caching? So revocation takes effect immediately. (Ch 4, 9)

### Q15. What is the N+1 query problem?
Fetching a list and then touching a related object on each item causes one extra query per item. It is fixed with `select_related` or `prefetch_related`, or by aggregating in the database. In the reports I avoid it entirely: four queries regardless of the number of doses.

**Follow-up:** How would you detect it? A query-count assertion in a test, or the debug toolbar. (Ch 10)

### Q16. What does `transaction.atomic()` do and where do you use it?
It wraps statements in one transaction so they commit together or roll back together. The reminder claim uses it to flip the dose status and insert the log row atomically. Taking a dose uses it with a row lock so concurrent actions cannot both win.

**Follow-up:** What happens on an exception inside? Everything in the block rolls back. (Ch 7, 8)

### Q17. What are Django signals and are you comfortable with them?
Signals let code react to model events. I use them so saving a schedule regenerates its future doses. They are convenient but hide control flow, so I keep the receiver tiny, call a normal service function, and test it directly.

**Follow-up:** What is the risk? Signals do not fire for `bulk_create` or queryset `update`, so those paths need care. (Ch 5, 6)

### Q18. How do migrations work, and what did you check in CI?
Each model change becomes a numbered migration; `migrate` applies unapplied ones in order. CI runs `makemigrations --check`, which fails if models and migrations disagree. I also used `AddIndexConcurrently` for large-table indexes.

**Follow-up:** Can a migration be unsafe? Yes: adding a non-null column or a blocking index on a huge table can lock it. (Ch 3, 11)

### Q19. How is the API documented?
drf-spectacular generates an OpenAPI schema and Swagger UI from the views and serializers. CI runs `spectacular --validate --fail-on-warn`, so the docs cannot silently rot.

**Follow-up:** Why fail on warnings? A warning usually means a view is undocumented or ambiguous. (Ch 14)

### Q20. How does pagination work on the audit endpoint?
Limit and offset style with a default of 50 and a maximum of 200, newest first. The maximum prevents a client from requesting an unbounded page.

**Follow-up:** Limits of offset pagination? Deep pages get slow and shift when rows are inserted; keyset pagination is better for very large logs. (Ch 9)

---

## Group 3: PostgreSQL

### Q21. What is a unique constraint and why prefer it to an application check?
It makes the database reject duplicates, including from concurrent transactions. An application check ("does it exist?") followed by an insert has a race: both requests can pass the check. `DoseEvent` has UNIQUE(schedule, scheduled_at), so duplicates are impossible.

**Follow-up:** How do you insert safely then? Insert and handle the conflict, here `ignore_conflicts=True`. (Ch 3, 6)

### Q22. What is `FOR UPDATE SKIP LOCKED`?
`FOR UPDATE` locks the selected rows until the transaction ends. `SKIP LOCKED` makes other transactions skip rows that are already locked instead of waiting. That lets several workers take disjoint batches from one table without blocking.

**Follow-up:** Downside? A skipped row may be processed later than expected, and the results are not a consistent snapshot. (Ch 7)

### Q23. What is a partial index?
An index over only the rows that satisfy a WHERE condition. `dose_open_idx` covers pending and reminded doses only, so it is 240 kB instead of 7.3 MB and the reminder query reads far fewer pages.

**Follow-up:** When can the planner use it? Only when the query's condition implies the index condition. (Ch 11)

### Q24. What is a covering index?
An index that includes all columns a query needs, so PostgreSQL can answer from the index without visiting the table (an index-only scan). `dose_patient_cover_idx` serves the report counts. The cost is a larger index, 56 MB here against 30 MB before.

**Follow-up:** Why count `status` and not `id`? So that the needed columns are exactly those in the index. (Ch 10, 11)

### Q25. How do you read `EXPLAIN ANALYZE`?
Look at the plan nodes (Seq Scan, Index Scan, Index Only Scan), the estimated versus actual rows, the time per node, and with BUFFERS the pages touched. A large estimate gap suggests stale statistics. Seq Scan on a large table in a hot query is a red flag.

**Follow-up:** Does an index always get used? No; on small tables or when most rows match, a sequential scan is cheaper. (Ch 11)

### Q26. What isolation level do you use and why does it matter?
The default, READ COMMITTED. Each statement sees data committed before it started, so a conditional UPDATE re-checks its condition on rows changed by a concurrent transaction. `mark_missed_doses` relies on this: it is a single UPDATE whose WHERE clause is re-evaluated, so a dose just marked taken is not overwritten.

**Follow-up:** When would you need a stricter level? When a decision depends on several reads staying consistent; I used single conditional statements and locks instead. (Ch 7)

### Q27. What are check constraints good for?
They make impossible states unrepresentable. `AccessGrant` has checks that email is lowercase, an active grant has a grantee, and a revoked grant has a timestamp. Even a bug in application code cannot create a contradictory row.

**Follow-up:** How do you test them? Try to insert a bad row and expect an `IntegrityError`. (Ch 3, 9)

### Q28. Why store timestamps as `timestamptz`?
Django with `USE_TZ=True` stores aware datetimes in UTC in `timestamptz` columns. They represent a single instant, and comparisons and range queries behave correctly regardless of session timezone.

**Follow-up:** Does timestamptz store the zone? No; it stores UTC and converts on display. (Ch 6)

### Q29. What does a half-open range mean in your reports?
The range is [start, end): start included, end excluded. Adjacent ranges then never double count or leave a gap, and it avoids the "23:59:59.999" trap. The local day boundaries are converted to UTC first.

**Follow-up:** How does that interact with DST? A local day can be 23 or 25 hours long, which is why you convert the boundaries rather than adding 24 hours. (Ch 10)

### Q30. How did you build the new indexes without downtime?
`AddIndexConcurrently` builds without blocking writes, and the new indexes were added before the old ones were dropped so queries always had an index. Concurrent builds cannot run inside a transaction, so those migrations are marked non-atomic.

**Follow-up:** What if the concurrent build fails? It leaves an invalid index that must be dropped and rebuilt. (Ch 11)

---

## Group 4: Celery and Redis

### Q31. What is Celery and how is it deployed here?
A distributed task queue. Redis is the broker and result backend through one `REDIS_URL`. I run workers to execute tasks and Beat to schedule them. A `rediss://` URL is accepted for hosted TLS Redis, and a missing `ssl_cert_reqs` gets `required` added.

**Follow-up:** Why default to requiring certificates? Secure by default; relaxing it is an explicit choice. (Ch 2, 12)

### Q32. What does Beat do and what are your periodic tasks?
Beat enqueues tasks on a schedule. Mine are daily dose generation at 00:10 UTC, the every-minute reminder sweep (`dispatch_reminders`), a five-minute `mark_missed_doses`, and an hourly task for weekly summaries. Beat does not run work itself.

**Follow-up:** What if Beat runs twice? Tasks are idempotent so a duplicate run is harmless. (Ch 7)

### Q33. How do you keep tasks safe to run twice?
Each task relies on constraints and conditional updates rather than memory. Generation uses unique constraints plus `ignore_conflicts`; delivery uses a lease token; missed marking is a conditional UPDATE. Running them again changes nothing that is already done.

**Follow-up:** What about retries after a crash? The lease expires and recovery rotates the token so a new worker can take over. (Ch 7)

### Q34. Why not send the email inside the claiming transaction?
Network calls are slow and can hang, which would hold locks and connections open. Instead the transaction only records the intent, and the email is sent afterward under a lease. This keeps transactions short and lets recovery handle crashes.

**Follow-up:** What is the cost? A crash after sending but before recording can cause a duplicate, which I accept and document. (Ch 7)

### Q35. What is the lease and how long is it?
A lease is a time-limited claim on a send, stored as a token and `lease_until` on the log row. It is 600 seconds. Startup checks that it is at least twice the email timeout plus 30 seconds, so a healthy send always finishes before its lease can be stolen.

**Follow-up:** What if it is too short? Another worker could resend while the first is still sending. (Ch 7)

### Q36. How are retries scheduled?
Exponential back-off: 60 times 2 to the (n minus 1) seconds, up to 5 attempts, then the log is `failed`. The next attempt time is stored on the row, so a recovery sweep finds due retries even after a restart.

**Follow-up:** Why store it in the database? Broker-only retries are lost if the broker loses its data. (Ch 7)

### Q37. What happens if Redis goes down?
Reminders already claimed stay recorded in PostgreSQL, so after Redis returns, recovery re-enqueues stuck sends. Throttling fails open and logs an error. API requests that do not need Redis keep working, although the health check reports it.

**Follow-up:** Is that acceptable? For login it avoids a total lockout; the trade-off is documented. (Ch 7, 12)

### Q38. What is Celery's eager mode and what problem did it cause?
Eager mode runs tasks inline, which is handy in tests. Celery guards against `result.get()` inside a task with one process-wide boolean that eager mode saves and restores without a lock. My concurrency tests start tasks from several threads on purpose, so the restores could interleave and leave the flag stuck on True, failing later unrelated tests. I proved it with a small two-thread script on both Python versions, fixed it without weakening any test, and confirmed with repeated full runs on 3.12 and 3.13.

**Follow-up:** Was it a Python bug? No, it is an unlocked flag inside Celery; the script reproduces it on both versions, and only the timing made 3.12 fail in CI. (Ch 13)

### Q39. How do you test scheduled tasks?
Call the task functions directly with a controlled `now`, and test the schedule configuration separately. Time is a parameter, so tests do not sleep or mock the clock globally.

**Follow-up:** Why pass `now`? It makes the time-dependent logic deterministic. (Ch 13)

### Q40. Why Redis for the broker and not RabbitMQ?
Redis is simpler to run and also serves the cache for throttling. RabbitMQ has stronger delivery features, but because my guarantees live in PostgreSQL the broker only needs to be a fast pipe. If the broker drops a message, recovery from the database re-sends it.

**Follow-up:** What would make you switch? Very high volume or a need for routing and per-message acknowledgements. (Ch 2, 16)

---

## Group 5: Concurrency and reliability

### Q41. What is a race condition? Give one that your design prevents.
A bug whose outcome depends on the timing of concurrent operations. Two workers reading the same pending dose and both sending a reminder is one. The claim uses `FOR UPDATE SKIP LOCKED` inside a transaction, so each dose goes to exactly one worker, and a unique constraint on (dose_event, channel) is the backstop.

**Follow-up:** Why the backstop? Locks protect the normal path; constraints protect against bugs and unexpected paths. (Ch 7)

### Q42. Explain at-least-once versus at-most-once, and which you chose.
At-most-once never retries so it can lose messages; at-least-once retries until recorded so it can duplicate. For medication a lost reminder is worse than a repeated one, so I chose at-least-once. The only duplicate window is when the provider accepted the email and the worker died before recording `sent`; the same Message-ID is reused on resend.

**Follow-up:** Can you get exactly-once? Not across two systems; you approximate it with idempotent receivers. (Ch 7)

### Q43. What does the lease token protect against?
A worker that is slow or paused could wake up after its lease expired and another worker took over. `_acquire` is a single conditional UPDATE that swaps the token, and `_finish` only records a result while the worker still owns the token. A stale worker therefore cannot overwrite the newer attempt.

**Follow-up:** How did you prove the token check matters? Removing it is caught only by the real-thread test. (Ch 7, 13)

### Q44. What happens if a worker crashes mid-send?
The log row stays `sending` with a `lease_until`. When the lease expires, `reserve_retries_and_stuck` rotates the token and re-enqueues the send, so another worker finishes the job. This is why a reminder is not lost.

**Follow-up:** Could that send twice? Only in the documented window where the provider already accepted the message. (Ch 7)

### Q45. How do you guarantee a reminder is not missed if workers are down?
Doses stay `pending` in the database, and the claim window starts 60 minutes before now, so a short outage is caught up when workers return. If workers are down for more than the window, that reminder is not sent, because a very late reminder could confuse the patient; the dose is eventually marked missed. This is a deliberate limit.

**Follow-up:** Could you widen the window? Yes, but late reminders become misleading, so the product decision matters. (Ch 7, 16)

### Q46. What is idempotency and how do you apply it to the "mark taken" endpoint?
Repeating the operation gives the same result as doing it once. If a dose is already taken, the API returns it unchanged instead of an error, so retries and double clicks are harmless. Invalid transitions, such as taking a skipped dose, return 409.

**Follow-up:** Why not just return an error on repeat? A client that retried after a network timeout would see a failure for something that actually succeeded. (Ch 8)

### Q47. What is a deadlock and how do you avoid it?
Two transactions each hold a lock the other needs, so neither can proceed, and PostgreSQL aborts one. Avoid by keeping transactions short, locking in a consistent order, and not doing slow external work inside them. `SKIP LOCKED` also removes waiting in the claim path.

**Follow-up:** How do you handle one when it happens? Retry the transaction. (Ch 7)

### Q48. What is the "taken late" logic?
If a dose was already marked missed and the patient then takes it, it becomes taken (late) and the `missed_at` time is kept. That preserves the true history for reports while still crediting the dose.

**Follow-up:** Does a late take count as adherent? It counts as taken in the ratio, and the history shows it was late. (Ch 8, 10)

### Q49. How did you test concurrency?
With real threads, a barrier so they start together, one database connection per thread, and `transaction=True` so commits are visible across connections. A single-threaded test cannot expose a race. I also ran deliberate breakages (mutations) to confirm the tests fail when the protection is removed.

**Follow-up:** Why not mocks? Mocks cannot reproduce real lock behaviour in PostgreSQL. (Ch 13)

### Q50. What guards run at startup and why?
Configuration invariants: the lease must be at least twice the email timeout plus 30 seconds, and the grace period must be shorter than the missed-after time. Violating them would break the delivery guarantee, so the app refuses to start instead of running unsafely.

**Follow-up:** Why fail loud? A silently wrong timing setting would only show up as lost or duplicate reminders in production. (Ch 12)

---

## Group 6: Security and health-tech privacy

### Q51. How is authentication done?
Email and password login returns a JWT access token (30 minutes) and a refresh token (7 days) from simplejwt, signed with the secret key. The frontend sends the access token in the Authorization header. Passwords are hashed with PBKDF2 at 1,000,000 iterations and checked by four validators.

**Follow-up:** Limits? No rotation or blacklist, so logout is client-side and a stolen refresh token works until it expires. (Ch 4, 16)

### Q52. How do you stop brute-force login?
Throttles: 10 attempts per minute per IP and 5 per minute per account, where the account key is a hash of the email so addresses are not stored in cache keys. Responses are the same for unknown users and wrong passwords. Throttling fails open if Redis is down, which I documented as a trade-off.

**Follow-up:** Behind a proxy? The `NUM_PROXIES` setting tells DRF how to read the client IP; the default is 0. (Ch 12)

### Q53. Why 404 instead of 403?
A 403 says "this exists but you cannot see it"; a 404 says nothing. For health data, confirming that a patient or record exists is itself a leak, so unauthorised and nonexistent look the same.

**Follow-up:** Does that hurt debugging? Slightly; the server logs record the reason without exposing it to the caller. (Ch 9)

### Q54. How do you protect patient privacy in logs?
Structured logs through `log_event` contain only ids, counts and event names, never emails, names or medication names, and exceptions are logged by class, not message. The database `error` column on a failed notification does store a message, which I note as a limitation.

**Follow-up:** Why not log messages? Exception text can include user data from a query or an address. (Ch 12)

### Q55. What is an audit log and what does yours record?
A record of who looked at what. Before any shared data is returned, a row is written with the viewer's email and role (copied, so it survives user deletion), the patient and the time. The patient can read their own access log. Views by the patient themselves and denied requests are not logged.

**Follow-up:** Why write before returning? So data is never returned without a record. (Ch 9)

### Q56. How is consent enforced?
Through `AccessGrant`: the patient invites an email, only that email can accept, and each request checks the grant is active in the database. The patient can revoke at any time and the effect is immediate. Constraints in the table prevent contradictory states.

**Follow-up:** How do you stop someone accepting with a different account? The accepting user's email must match the invited email, checked under a row lock. (Ch 9)

### Q57. What does the signed dose link protect?
The email contains a link that marks a dose taken. It is signed with `django.core.signing` with its own salt, expires in 24 hours, and carries the dose and patient ids. GET only shows a page, since scanners prefetch links, and a POST performs the action. Responses are `no-store`, `no-referrer` and `noindex`, and the endpoint is throttled before the token check.

**Follow-up:** Why exempt it from CSRF? The signed token is the authorisation, and the user is not logged in. (Ch 8)

### Q58. How is the secret key handled?
Read from the environment, with validation outside DEBUG that rejects short or placeholder keys. `.env.example` contains only placeholders and a test keeps it in sync with the variables the code reads. Real secrets are never committed.

**Follow-up:** What if the key leaks? All tokens and signed links can be forged until you rotate it, which invalidates them. (Ch 12)

### Q59. What are the privacy risks of reminder emails?
Email is not end-to-end encrypted and the message contains a medication name, which is sensitive. That is a real limitation. Mitigations to consider are generic wording, letting patients choose the detail level, and a notification channel with better privacy.

**Follow-up:** What regulation applies? Depends on the region, for example HIPAA in the US or GDPR in the EU; I would involve legal and compliance review before production. (Ch 12, 16)

### Q60. How does CORS apply here?
The frontend runs on a different origin, so the API sends CORS headers only for origins in `CORS_ALLOWED_ORIGINS`, only under `/api/`, without credentials. It is a browser protection for users and does not replace authentication.

**Follow-up:** Why no credentials? Tokens go in a header, not cookies, so cookies are not needed. (Ch 12, 15)

---

## Group 7: Testing

### Q61. What is your testing strategy?
Pytest with pytest-django. Unit tests for pure logic such as time conversion, integration tests against real PostgreSQL for constraints and queries, API tests per endpoint, real-thread concurrency tests, configuration tests, and a frontend suite. Coverage has a 95 percent floor in CI.

**Follow-up:** Is 99 percent coverage enough? No, coverage shows lines executed, not behaviour verified, so I added mutation experiments. (Ch 13)

### Q62. Why test against PostgreSQL and not SQLite?
My guarantees use PostgreSQL features: row locks with SKIP LOCKED, partial and covering indexes, `timestamptz` and constraints. SQLite would pass tests that fail in production.

**Follow-up:** Cost? Slower setup, and CI needs a PostgreSQL service. (Ch 13, 14)

### Q63. What is a pytest fixture?
A reusable setup function that tests request by naming it as an argument. For example `patient` creates a user and `patient_api` is an authenticated client. Fixtures can depend on each other and clean up after the test.

**Follow-up:** Scope? Function scope by default so tests stay independent. (Ch 13)

### Q64. How do you test time-dependent code?
Pass `now` as a parameter instead of reading the clock inside, and test daylight saving dates for several zones. The `local_to_utc` tests cover the gap and the overlap, and using plain UTC instead fails 16 tests.

**Follow-up:** Which zones? Asia/Kolkata (no DST) and America/New_York (DST), plus others. (Ch 6, 13)

### Q65. What is a mutation experiment?
Deliberately breaking the code to check that a test fails. If it does not, the tests are not protecting that behaviour. One experiment found a gap: removing a guard was not caught until I added a test that keeps the guard raised until the last overlapping task finishes.

**Follow-up:** Did you automate it? No, I did them manually; a tool such as mutmut could automate it. (Ch 13)

### Q66. Tell me about a flaky test you fixed.
Two. An index test depended on planner statistics and could pass or fail with table size, so I rebuilt it around stable scenarios with negative controls. The Celery guard race caused a 3.12-only CI failure; I found the root cause, fixed it and ran repeated full runs on both versions. I did not skip or weaken any test.

**Follow-up:** How do you prove a flake is fixed? Many repeated runs, not one green run. (Ch 13)

### Q67. What do the frontend tests cover?
450 Vitest tests in 31 files: components, hooks, the API client with refresh and retry, route protection by role, report states (loading, data, empty, no access) and a test proving demo mode is compiled out when the variable is not set.

**Follow-up:** Do you test the real backend from the frontend? No end-to-end suite is in the repo; I verified in a real browser manually. (Ch 15, 16)

### Q68. How does CI work?
GitHub Actions runs a matrix on Python 3.12 and 3.13 with PostgreSQL 16 and Redis 7 services: `check`, `makemigrations --check`, the schema validation, and pytest with coverage floor. A separate job runs frontend lint, type check, tests and build. There is no deploy step.

**Follow-up:** What is fail-fast false? Both Python versions finish so one failure does not hide the other. (Ch 14)

### Q69. How would you test the email sending?
Use Django's in-memory email backend in tests and assert on the outbox, and simulate send failures and timeouts to test retries and the final `failed` state. Real SMS and WhatsApp are never sent.

**Follow-up:** Real provider tests? Only in a staging environment with a sandbox account. (Ch 7, 13)

### Q70. What would you add to testing next?
Browser end-to-end tests, load tests of the claim query at scale, and automated mutation testing. I would also make `test_health_ok` skip when Redis is unreachable, because today it fails with a 503.

**Follow-up:** Why load tests? Measurements on one scratch database do not show behaviour under contention. (Ch 16)

---

## Group 8: System design extensions

### Q71. How would you scale to 1 million patients?
First measure. Doses grow roughly with patients times doses per day, so the open-dose partial index and covering report index keep the hot paths small. Add more workers since the claim uses SKIP LOCKED, then read replicas for reports, partitioning the dose table by time, and archiving old doses. Redis and the mail provider need capacity planning too.

**Follow-up:** What breaks first? Probably the per-minute sweep becoming a single hot query and email provider rate limits. (Ch 11, 16)

### Q72. How would you add SMS and WhatsApp?
Through the notification-channel interface, adding one class per channel and enabling it in configuration. The unique (dose_event, channel) constraint already gives each channel its own idempotent log, so retries and leases work unchanged. You also need patient consent and opt-out per channel, templates, and provider webhooks for delivery status. The project deliberately never sends real SMS or WhatsApp.

**Follow-up:** What is different from email? Providers return delivery receipts asynchronously and may have approved-template rules. (Ch 7, 16)

### Q73. How would you support multiple regions?
Keep a single writer database per patient region if data residency requires it, or use one primary with regional read replicas. Run workers near the database. Timezones already work per patient, so scheduling is region-independent. The hard part is cross-region failover without duplicate reminders, so the claim must stay on one primary.

**Follow-up:** Why not multi-primary? Row locks and unique constraints rely on a single source of truth. (Ch 16)

### Q74. How would you deploy it?
Containers or managed services: web app behind a load balancer, separate worker and beat processes, managed PostgreSQL and Redis, secrets in the platform's secret store, migrations run as a release step, health checks. Only one Beat instance should run. Add monitoring for queue depth, delivery failures and the age of the oldest pending dose.

**Follow-up:** Zero-downtime migrations? Add columns and indexes concurrently, deploy code that works with both schemas, then remove old pieces. (Ch 11, 16)

### Q75. What would you monitor?
Reminder lateness (time between due and sent), count of `failed` logs, queue depth, number of expired leases recovered, email provider errors, and API error rates and latency. Alerts on the oldest due-but-unsent dose are the most meaningful for a reminder product.

**Follow-up:** Where do metrics come from? Structured log events and database queries, exported to a metrics system. (Ch 12, 16)

### Q76. How would you handle a thundering herd at 08:00?
Many patients share popular times, so the sweep finds thousands of doses at once. The batch size caps each claim, several workers claim disjoint batches, and I would add per-channel rate limits and jitter within the lead window. The claim is the bottleneck to measure first.

**Follow-up:** Does batching delay reminders? Slightly, so batch size and sweep frequency are tuned against the lateness metric. (Ch 7, 11)

### Q77. How would you add push notifications?
Another channel implementing the same interface, with device token storage and provider-specific error handling such as removing invalid tokens. The reliability design is unchanged.

**Follow-up:** What about quiet hours? A per-patient preference applied when the claim chooses doses or channels. (Ch 7)

### Q78. How would you add refresh-token rotation and logout?
Enable simplejwt rotation with blacklisting so each refresh token is single-use and can be revoked, add a logout endpoint that blacklists it, and have the frontend clear its tokens. Cost: a database table and lookups on refresh.

**Follow-up:** What about access tokens? They stay valid up to 30 minutes, which is why they are short. (Ch 4, 16)

### Q79. How would you design the data retention policy?
Decide how long doses, logs and audit records must be kept, which depends on regulations. Partition or archive old doses and logs, keep audit records longer, and offer patient export and deletion. Foreign keys such as the audit viewer use SET NULL with copied email so history survives account deletion.

**Follow-up:** Is deleting a patient easy? It needs a defined procedure because of audit and legal retention. (Ch 9, 16)

### Q80. If you had two more weeks, what would you do?
Week one: email verification, password reset, token rotation and logout, and verified caregiver and doctor roles. Week two: a deployment pipeline with a staging environment, monitoring and alerts on reminder lateness, and browser end-to-end tests. Then SMS and WhatsApp behind consent.

**Follow-up:** Why this order? Security of health data first, then the ability to run and observe the system, then new features. (Ch 16)

---

## How to practise with this bank

* Day 1 to 2: groups 1 and 2, speaking each answer aloud in under 60 seconds.
* Day 3 to 4: groups 3 to 5, which are the deep technical ones.
* Day 5: groups 6 and 7.
* Day 6: group 8, then answer every follow-up without looking.
* Always say the limitation honestly when an answer has one.

## Interview questions on this chapter

1. **Q: How should I handle a question the bank does not cover?**
   **A:** Say what you know, connect it to something in the project, and say plainly what you would check. Interviewers value honest reasoning over bluffing.

2. **Q: What if the interviewer says "your answer is wrong"?**
   **A:** Listen, ask what they have in mind, and check your reasoning. If you are right, explain it with the code; if not, say "that makes sense, I had not considered that".

3. **Q: How do I answer in under a minute?**
   **A:** Use the order: one-sentence answer, one reason, one project example, one limitation.

4. **Q: Which five questions are most likely?**
   **A:** Q1, Q2, Q9, Q42 and Q71. Know them best.

5. **Q: How do I use follow-ups?**
   **A:** After you answer, think about the next obvious question. If you can already answer it, you understand the topic rather than the script.

6. **Q: Should I mention the measured numbers?**
   **A:** Yes, when relevant, but only the ones in the cheat sheet. Precise numbers show you measured.

7. **Q: Is it fine to say "I used AI tools"?**
   **A:** Yes, and chapter 19 shows how to say it honestly and confidently.

8. **Q: How do I show depth without rambling?**
   **A:** Give the short answer first, then say "I can go deeper on the locking if you like".

## Common mistakes to avoid

* Memorising answers word for word and sounding scripted.
* Claiming guarantees the system does not give, such as exactly-once or full security.
* Quoting numbers you have not rehearsed.
* Skipping the limitations; interviewers will find them anyway.
* Answering a different question from the one asked.
* Going silent when stuck instead of thinking aloud.

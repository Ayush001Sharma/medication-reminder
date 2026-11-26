# 16. Honest limitations and what I would improve next

Every real system has limits. In an interview, being able to list yours calmly, explain *why* each exists and
say *what you would do first* is a sign of seniority. This chapter collects the limits documented in the
project's README ("Known limitations") plus the ones found while writing this guide, grouped by theme. Each item
says what is true, why it matters, and what the fix would be.

Everything here is something the code or a test showed. Nothing is a guess about code I have not read; where a
statement is an inference, it says so.

## 1. First principles: how to talk about limitations

* **State it plainly.** "There is no password reset." Not "it is mostly secure."
* **Explain the risk, not just the gap.** Who is affected and how badly?
* **Show you chose.** Many limits are deliberate scope decisions for a first version.
* **Prioritise.** Fix what protects people first (security and privacy), then reliability, then convenience.
* **Say how you would verify the fix.** A test, a measurement or a monitor.

## 2. The limitations

### A. Security and accounts

| Limitation | Why it matters | What I would do |
|---|---|---|
| **No email verification, password reset or account deletion** | Anyone can register with someone else's email; a forgotten password cannot be recovered | Verification link and reset flow (signed, expiring tokens like the dose link), and a deletion endpoint |
| **Refresh tokens are not rotated or blacklisted; there is no server-side logout** | A stolen refresh token works for up to 7 days; "sign out" only forgets the token in the browser | Enable simplejwt rotation and the token blacklist app, and make logout call the API |
| **Caregiver and doctor identities are not verified** | Anyone can register as a doctor | The role alone grants nothing (a patient must invite you), but a verification step (licence check, or an out-of-band invite) would make the label meaningful |
| **Rate limiting is approximate, fails open, and the per-account login limit can annoy a user** | An attacker can lock a victim's login for a minute by guessing wrongly; during a Redis outage there is no throttling | Add progressive delays or CAPTCHA after repeated failures, and alert on `ratelimit.cache_unavailable` |
| **`DEBUG` defaults to true** (`config/settings.py`) | A deployment that forgets `DJANGO_DEBUG=false` would run in debug mode | Default to false and require an explicit opt-in for development (the secret-key check already forces a real key when debug is off) |

### B. Privacy

| Limitation | Why it matters | What I would do |
|---|---|---|
| **Reminder emails contain the medication name and dose** (`notifications/content.py`) | The subject and body pass through email systems and inboxes; medication reveals diagnoses | A neutral message ("It is time for your medicine") with a link to details after login or the signed link |
| **`NotificationLog.error` stores the provider's error text** (`_record_failure`) | The text can echo an address; it lives in the database | Store only the error class and a short code, or redact addresses before saving |
| **No data-retention or deletion policy** | Health data kept forever; no way for a user to erase it | Define retention, add account deletion with a documented effect on audit rows |
| **Audit rows are deleted with the patient** (`CASCADE`) | Fine for privacy, but there is no separate retention rule for the audit trail | Decide explicitly whether and for how long audit data outlives the account |

### C. Reliability of reminders

| Limitation | Why it matters | What I would do |
|---|---|---|
| **At-least-once, with one narrow duplicate window** (chapter 07) | If the provider accepts and the worker dies before recording `sent`, the patient may get two reminders | Accept it (a deliberate choice), keep the stable `Message-ID`, and measure how often `reminder.recovered` fires |
| **No reminder if workers are down for more than the 60-minute grace window** | A long outage means missed reminders for that period (doses are later marked `missed`) | Alert quickly when the worker or Beat stops, and consider a catch-up message for the first doses after recovery |
| **Beat is a single process and a single point of failure** (inference from the design: one clock enqueues all four jobs) | If Beat stops, nothing is claimed | Run it under a supervisor with health monitoring; duplicate ticks would be harmless because every task is idempotent |
| **Dose generation looks only 7 days ahead** (`HORIZON_DAYS`) | If the daily generation job did not run for more than a week, future doses would run out (inference from the code) | Monitor that job's last success; consider a longer horizon |
| **Lead, grace and missed windows are global** (settings), not per patient or medication | A time-critical drug and a vitamin share the same rules | Per-medication reminder settings |
| **Only email is real; SMS and WhatsApp are log-only stubs** (`CLAUDE.md` forbids sending real ones) | People who do not read email get no reminder | Implement a provider behind the existing `NotificationChannel` interface |
| **SMTP has only been exercised against the console and in-memory backends**, not a real provider | Real providers add bounces, rate limits and delivery delays that are untested | Test against a real provider in a staging environment |

### D. Product and data model

| Limitation | Why it matters | What I would do |
|---|---|---|
| **Timezone changes affect future doses only**; there is no per-dose manual time | Travelling patients cannot adjust a single dose | Temporary timezone override, or per-dose rescheduling |
| **A medication cannot be reactivated, and there is no undo for taken or skipped** | Mistakes are permanent by design (history is trusted) | An explicit correction action that records who changed what and when, instead of silent edits |
| **Caregivers and doctors can read reports only**; reminders go to the patient only | A caregiver cannot receive reminders or see dose lists | Optional shared reminders and a limited dose view, gated by the grant |
| **No invitation email** | The invited person must be told another way | Send an email carrying a signed link, built like the dose link |
| **`QuerySet.update()` bypasses signals** (documented in `scheduling/signals.py`) | Bulk updates can leave doses out of step | Rely on the daily job (already repairs) and avoid bulk updates on schedule inputs |
| **List endpoints other than the audit log are not paginated** (`MedicationViewSet`) | A patient with a very long list of medications returns everything in one response | Add pagination if lists can grow |

### E. Operations

| Limitation | Why it matters | What I would do |
|---|---|---|
| **No deployment pipeline** and the frontend build is not hosted anywhere | CI proves checks pass; nothing ships | A deploy job with manual approval, migrations run safely, a staging environment |
| **No metrics, alerting or tracing** (there are structured logs only) | You find out about failures by looking | Count `reminder.*` events, alert on `failed`, `recovered` and `lease_lost_after_send`, add a dashboard |
| **No dependency-vulnerability scanning, no backups story documented** | Known-vulnerable packages or data loss go unnoticed | `pip-audit` and `npm audit` in CI; documented database backups and a restore drill |
| **Windows workers use `--pool=solo`**: one task at a time, no hard time limit | Slow emails delay others | Use Linux workers in production, as the README says |
| **Windows setup steps were walked through but not run on Windows** (README) | They may contain mistakes | Run them on a real Windows machine and fix |

### F. Quality and testing

| Limitation | Evidence | What I would do |
|---|---|---|
| **README statement about Redis in tests is slightly wrong** | With Redis stopped, `test_real_redis_and_database` skips but `tests/test_skeleton.py::test_health_ok` **fails** (503, verified in chapter 14) | Correct the README, or make that test skip when Redis is unreachable |
| **One frontend test is timing sensitive** | In 1 of 9 full-suite runs `ReportPage` "asks for the default range" failed after about 1,053 ms, near the 1 s default `findBy` timeout; 8 later full runs and 6 isolated runs passed | Likely the lazily loaded chart chunk under load. Raise the timeout for lazy-loaded elements or preload the chunk in tests. Reproduce under CPU stress first |
| **Index plan tests copy the query shapes** (`tests/test_indexes.py`) | The tests define their own `claim_query()` etc. rather than importing the real ones | Share the query builders so a change to the application query changes the test |
| **No browser end-to-end tests in CI** | The real-browser checks (axe with colour contrast, layouts) were run by hand against the real backend | Add Playwright to CI |
| **Performance numbers are from one machine** | `EXPLAIN` results in chapter 11 are from a scratch database | Keep a repeatable benchmark script in the repository and track it over time |

## 3. What I would improve first, and why (a priority order)

A reasoned order is more convincing than a list:

1. **Password reset, email verification, refresh-token rotation with blacklist and real logout.** *Why first:*
   they protect users from account takeover, the biggest harm in a health app, and they are well-understood
   features.
2. **Alerting on the reminder pipeline** (worker or Beat down, `reminder.failed`, `reminder.recovered`,
   `reminder.lease_lost_after_send`, the daily generation job missing). *Why:* the product's promise is "never
   missed"; an outage should page someone within minutes, not be discovered by a patient.
3. **Neutral reminder emails and redacted stored errors.** *Why:* cheap changes that reduce how much sensitive data
   sits in inboxes and databases.
4. **A real SMS or WhatsApp channel** behind the existing interface, with the same idempotency. *Why:* reach.
   The channel abstraction exists so only the sending class changes.
5. **A deployment pipeline with staging, backups and dependency scanning.** *Why:* turns "tests pass" into
   "software runs safely".
6. **Fix the small test-quality issues** (the README Redis note, the timing-sensitive frontend test, sharing the
   index query builders). *Why:* they are quick, and a trusted test suite is what lets you move fast.
7. **Product features:** invitation emails, per-medication reminder rules, a correction flow instead of silent
   changes, caregiver reminders.

## 4. What I would deliberately keep

Knowing what *not* to change shows judgement:

* **Local clock times in schedules, UTC instants in doses** (chapters 05, 06).
* **Claim then send, outside the transaction, with a lease** (chapter 07) and its explicit at-least-once
  statement.
* **Constraints in the database**, not only in code (chapter 03).
* **404 for "no access", existence-blind invitations, audit before data** (chapters 04, 09).
* **Fail-loud configuration and tests that keep the docs honest** (chapter 12).
* **Real-thread concurrency tests and real PostgreSQL** (chapter 13).

## 5. A model answer to "What would you improve?"

> "Three things, in this order. First, account security: password reset, email verification and refresh-token
> rotation with a real logout, because a stolen account is the worst outcome for a health app and today a stolen
> refresh token works for a week. Second, operational alerting on the reminder pipeline, because the product
> promise is 'never missed' and right now I would find out about a dead worker by looking at logs. Third,
> privacy: reminder emails currently include the medication name and dose, so I would send a neutral message with
> a link. After that I would add a real SMS channel through the existing channel interface and a deployment
> pipeline. I would keep the core design: local-time schedules converted per date, the claim-then-send pipeline
> with leases, and database constraints, because those are what make the reliability and correctness claims
> true."

## Interview questions on this chapter

1. **Q: What are the biggest weaknesses of your project?**
   **A:** No email verification or password reset, refresh tokens that are not rotated or blacklisted (so a stolen
   one lasts 7 days and logout is client-side only), unverified doctor and caregiver roles, and reminder emails
   that contain the medication name. I would fix the account security items first.

2. **Q: Which limitations are deliberate and which are gaps?**
   **A:** Deliberate: at-least-once delivery, no undo for taken or skipped doses, medications that are stopped
   rather than deleted, SMS and WhatsApp as stubs because real messages were forbidden, reports-only access for
   caregivers. Gaps: verification, reset, rotation, alerting, deployment, a real SMTP test.

3. **Q: A patient could receive two reminders. How and how likely?**
   **A:** Only if the email provider accepts the message and the worker dies before saving `sent`; recovery then
   resends after the 10-minute lease with the same Message-ID. It requires a crash in a window of milliseconds, so
   it is rare, and I chose it over the opposite risk of silently losing a medication reminder.

4. **Q: What happens if Celery Beat stops?**
   **A:** No tasks are enqueued, so no reminders are claimed and no doses generated or marked missed. The system
   is designed so a restart recovers (everything is idempotent), but there is no redundancy or alerting yet, so
   that is on my list.

5. **Q: How would you make the reminders more private?**
   **A:** Send a neutral subject and body with a signed link, store only error classes in the database, keep ids
   and counts in logs (already done), and define retention and deletion policies.

6. **Q: What would you monitor in production?**
   **A:** Worker and Beat liveness, the counts of `reminder.failed`, `reminder.recovered` and
   `reminder.lease_lost_after_send`, the age of the oldest `sending` log row, the last successful run of dose
   generation, 429 and 5xx rates, and `ratelimit.cache_unavailable`.

7. **Q: What flaky tests did you find and what did you do about them?**
   **A:** Two fixed: a planner-dependent index test (now asserts index usability under three statistics scenarios)
   and a Celery thread-safety flaky test on Python 3.12 (fixed with a locked, counting guard and a regression
   suite). One more observed while writing this guide: a frontend test failed once in nine full runs near its 1 s
   timeout, probably a lazily loaded chart under load; I would reproduce it under CPU stress and raise the
   timeout for lazy elements.

8. **Q: Is your CI enough?**
   **A:** It is a solid base: matrix on two Python versions, real PostgreSQL and Redis, migration and schema
   checks, a coverage floor, and a frontend job. It lacks browser end-to-end tests, dependency scanning and any
   deployment, which I would add.

9. **Q: Why not just add SMS now?**
   **A:** The project brief forbids sending real SMS or WhatsApp. The channel interface exists so a provider is
   one new class, with the same claim, lease and retry logic, once it is allowed.

10. **Q: How do you decide what to fix first?**
    **A:** By harm and cost. Account takeover and privacy leaks harm users most, then missed reminders (the
    product's promise), then deployment and convenience. I prefer cheap changes with a large risk reduction, such
    as neutral email text.

## Common mistakes to avoid

* **Claiming it is "production ready".** Say what is missing.
* **Listing limits without a plan.** Pair each with a priority and a fix.
* **Hiding a flaky test or a wrong statement in the docs.** Say it, with the evidence, and what you would do.
* **Defending a deliberate limit as if it were perfect.** Explain the trade-off honestly (for example
  at-least-once versus at-most-once).
* **Over-promising security.** Do not say "unhackable"; say what layers exist and what is missing.
* **Reading this list as "do everything at once".** Prioritise by harm.
* **Forgetting to say what you would keep.** Good design decisions are part of the answer.

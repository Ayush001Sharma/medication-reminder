# 20. Cheat sheet: the whole project on two pages

Read this the night before an interview. Every number here was measured or read from the code; chapter numbers show where the detail lives.

## The project in one breath

A Django 5 / DRF backend where patients add prescriptions with dose schedules, the system emails reminders and tracks what was taken, and caregivers or doctors see an adherence report only for patients who granted access. Celery workers and Celery Beat (Redis broker) send reminders; PostgreSQL 16 stores everything; JWT secures the API; a React frontend in `frontend/` consumes it. Apps: `accounts`, `medications`, `scheduling`, `notifications`, `reports`.

## Key numbers

| Fact | Value |
|---|---|
| Backend tests / coverage | 460 tests, about 99.4 to 99.5 percent, CI floor 95 |
| Frontend tests | 450 Vitest tests in 31 files |
| Python in CI | 3.12 and 3.13, PostgreSQL 16, Redis 7 |
| Access / refresh token | 30 minutes / 7 days |
| Password hashing | PBKDF2, 1,000,000 iterations, 4 validators |
| Dose horizon | 7 days ahead; daily job 00:10 UTC |
| Reminder window | from 60 minutes ago to 60 seconds ahead; batch 200 |
| Retry back-off | 60 x 2^(n-1) seconds; 5 attempts then `failed` |
| Lease | 600 seconds; must be at least 2 x (email timeout + 30) |
| Missed after | 120 minutes; grace must be shorter than that |
| Report range | max 366 days, default last 30 local days |
| Rate limits | login 10/min per IP and 5/min per account; register 20/h; invite 20/h per patient; dose link 30/min |
| Dose link | signed, 24 h expiry, GET shows page, POST acts |
| Audit pagination | default 50, max 200 |

## Design decisions to name

1. **Schedules store local wall-clock times; doses store UTC.** Conversion is per date with `zoneinfo` (`local_to_utc`, fold=0). Gap: shift forward. Overlap: first occurrence. (Ch 6)
2. **Never twice, never missed** comes from the database, not from hope: UNIQUE(schedule, scheduled_at) on doses, UNIQUE(dose_event, channel) on logs, `FOR UPDATE SKIP LOCKED` claim, status flip and log insert in one transaction. (Ch 7)
3. **Claim, then send, outside any transaction.** A lease token plus `lease_until` marks who owns a send; `_acquire` is one conditional UPDATE; only the owner may record the result. (Ch 7)
4. **At-least-once**, with one narrow duplicate window (provider accepted, worker died before `sent`); same Message-ID on resend. Exception: workers down for more than 60 minutes miss that reminder. (Ch 7, 16)
5. **Recovery:** `reserve_retries_and_stuck` rotates tokens on expired leases so a dead worker's sends are retaken; `mark_missed_doses` is one UPDATE after 120 minutes. (Ch 7)
6. **Dose actions** are state-checked: taken from pending, reminded or missed (late if from missed); skip from pending or reminded; conflicts return 409; repeats are idempotent. (Ch 8)
7. **Consent model:** `AccessGrant` with constraints, existence-blind invites (always 202 with the same text), accept only by the matching email, live database check on every request, 404 rather than 403, audit row written before data is returned. (Ch 9)
8. **Adherence** = taken / (taken + missed). Skipped, pending and future doses are excluded. No data gives a null percentage, never 0 percent. Streak = taken doses since the latest missed one. (Ch 10)
9. **Reports cost four queries regardless of size** via conditional aggregation. (Ch 10)
10. **Indexes:** partial `dose_open_idx` (240 kB), covering `dose_patient_cover_idx` (56 MB), `dose_patient_missed_idx` (2.4 MB), `notif_sending_idx` (16 kB), built with `AddIndexConcurrently`. (Ch 11)
11. **Fail loud:** secret-key validation outside DEBUG, startup invariants, config tests keep `.env.example` and README in sync. Rate limits fail open when Redis is down. (Ch 12)
12. **Privacy:** logs hold ids and counts, never names or emails; exception class not message; role read from the database, not the token. (Ch 12)

## Measured performance (1,000,000 doses, 300,000 logs)

| Query | Before | After |
|---|---|---|
| Idle reminder claim | 4.25 ms, 4,032 buffers | 0.28 ms, 18 buffers |
| Busy claim (1,000 due) | 13.0 ms, 7,432 buffers | 4.3 ms, 6,415 buffers |
| Report, 90 days | 1.18 ms, 277 buffers | 0.15 ms, 9 buffers |
| Report, 366 days | 2.15 ms, 976 buffers | 0.34 ms, 11 buffers |
| Worst-case streak | 2.86 ms | 0.05 ms |

## Testing facts

- Real-thread concurrency tests: barrier, own DB connection per thread, `transaction=True`.
- Mutation experiment: removing the token check in `_acquire` is caught only by the real-thread test.
- `local_to_utc` using plain UTC fails 16 tests.
- Index tests depend on the planner, so they are built to be stable and include negative controls.
- The 3.12-only CI failure was a real race in Celery's eager-mode guard under threads, not a Python bug (commit 013676b). Fixed without weakening tests; 6 of 6 full runs on both versions passed.

## Frontend facts

React 18, Vite, TypeScript, Tailwind, React Router, Recharts, Vitest. One API client with Bearer header, single-flight token refresh and one retry. Tokens live in memory plus sessionStorage, never localStorage. Demo mode is compiled out unless `VITE_DEMO_MODE=true`. Colours come only from the design tokens in `src/index.css`.

## Honest limitations (say them first)

No email verification or password reset; refresh tokens not rotated or blacklisted; doctor and caregiver roles are not verified; email is the only real channel (SMS and WhatsApp are interface-ready but deliberately not sent); no deployment pipeline; workers down over 60 minutes means a missed reminder; the reminder email contains the medication name. (Ch 16)

## Thirty-second answers

- **What is it?** A reminder and adherence backend whose reliability comes from database constraints, row locks and idempotent tasks.
- **Hardest part?** Making reminders neither duplicate nor disappear when workers crash or overlap.
- **What would you improve first?** Account security (verification, reset, token rotation), then deployment and monitoring, then SMS and WhatsApp through the channel interface.
- **Did you write it yourself?** See chapter 19: built by directing an AI coding tool, with me reviewing, deciding and verifying.

## Interview questions on this chapter

1. **Q: Give me the five numbers that define the reminder timing.**
   **A:** The window runs from 60 minutes before now to 60 seconds ahead, the batch is 200, retries back off at 60 times 2 to the (n minus 1) seconds up to 5 attempts, the lease is 600 seconds, and a dose becomes missed after 120 minutes. The lease and grace are validated at startup against the email timeout and the missed-after setting.

2. **Q: What does the system guarantee about duplicates?**
   **A:** Database constraints prevent duplicate doses and duplicate logs per channel, and the claim never hands the same dose to two workers. Delivery is at-least-once, with one narrow window where a duplicate email is possible if the worker dies after the provider accepts but before `sent` is recorded.

3. **Q: Which result proves the index work mattered?**
   **A:** The idle claim went from 4.25 ms and 4,032 buffers to 0.28 ms and 18 buffers on a million doses, and a 90-day report from 277 buffers to 9.

4. **Q: What is the single biggest limitation?**
   **A:** Account security gaps (no verification, reset or token rotation), closely followed by the lack of a deployment pipeline.

5. **Q: Which two constraints make duplicates impossible?**
   **A:** UNIQUE(schedule, scheduled_at) on `DoseEvent` and UNIQUE(dose_event, channel) on `NotificationLog`. They hold even if application code has a bug.

6. **Q: How is the report percentage defined?**
   **A:** Taken divided by taken plus missed. Skipped, pending and future doses are excluded, and with no qualifying dose the percentage is null rather than 0.

7. **Q: What are the token lifetimes and the main weakness?**
   **A:** Access 30 minutes, refresh 7 days. Refresh tokens are not rotated or blacklisted, so logout is client-side only.

8. **Q: How do you handle the two awkward daylight saving cases?**
   **A:** A nonexistent local time shifts forward by the gap; an ambiguous one uses the first occurrence. Both follow from building the datetime with fold=0 in `local_to_utc`.

## Common mistakes to avoid

- Quoting numbers you have not checked. Use the table above, which came from the code and measurements.
- Saying "exactly once" or "never fails".
- Hiding the limitations. Naming them first reads as seniority.
- Memorising the sheet without understanding it; each line points to a chapter.

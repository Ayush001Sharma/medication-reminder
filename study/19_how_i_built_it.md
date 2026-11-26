# 19. How I built it: telling the truth about AI-assisted work

This chapter is different from the others. It does not teach code. It helps you describe, honestly and confidently, how this project came to exist, because the question "did you write this yourself?" is likely in any interview about it.

A rule first, because everything else depends on it: **say only what is true.** Interviewers can tell when a story has been polished into something it was not, and the cost of being caught is far larger than the cost of an honest, well-told answer. The good news is that the honest story here is a strong one.

---

## 1. What the record shows

These facts come from the repository itself (`git log`, `CLAUDE.md`, commit trailers). They are not opinions.

* The project was built in a Claude Code session, using an AI coding assistant that read files, wrote code, ran tests and committed. Every commit made in that session carries a `Co-Authored-By: Claude` trailer. Anyone can see that with `git log`, so there is nothing to hide and nothing to confess: it is public in the history.
* The work was directed through a sequence of prompts. `CLAUDE.md`, the project brief committed second, is the clearest record of **your** decisions as the person directing the work. It fixes the stack (Django 5, DRF, PostgreSQL, Celery with Redis, JWT, drf-spectacular, pytest), the five app names, the roles, the rule that all datetimes are stored in UTC with per-patient IANA timezones, the rule that a reminder must never be sent twice and never be missed, the secrets workflow, email as the real channel behind a channel interface, and the rule never to send real SMS or WhatsApp messages.
* The history, in order:

| Step | Commit | What it added |
|---|---|---|
| 1 | `23ae44c` | the project brief, `CLAUDE.md` |
| 2 | `08ca3dd` | skeleton: config, five apps, Celery, health check |
| 3 | `e6a5b7c` | accounts: custom user, JWT auth, roles, Swagger |
| 4 | `4df8692` | medications and scheduling models and APIs |
| 5 | `5ffdd11` | dose generation with DST handling, daily job |
| 6 | `d8a89eb` | the reminder pipeline: claim, send, leases, retries, missed |
| 7 | `88193eb` | dose actions and the signed email link |
| 8 | `b020afc` | access sharing, adherence reports, audit log, weekly summaries |
| 9 | `1f249ed` | "finish to a professional standard": indexes, rate limits, logging, CI, README |
| 10 | `20a5e92`, `6b72e1d` | fixes to a flaky index test, CI action versions |
| 11 | `fbf9d9c` to `c43d089` | the React frontend and demo mode |
| 12 | `013676b` | root-cause fix of the Python 3.12 CI failure |
| 13 | `40c12d7` to now | this study guide |

* Several requests you made are visible as standing constraints: do not print or commit secrets, do not send real SMS or WhatsApp, tokens never in localStorage, use only the design tokens and meet contrast rules, do not weaken or skip tests, do not lower the coverage floor.
* You also reported a real CI failure (the Python 3.12 one) and asked for the root cause, for repeated runs as proof, and for an explanation of whether it was a flaky test or a real version difference. Asking for evidence rather than a quick patch is a decision, and it is yours.

## 2. What that means in plain words

You specified and directed the project; an AI assistant wrote most of the code and tests; you reviewed results, set requirements and constraints, and asked for proof. The study guide you are reading exists so that you can now understand and explain what was built.

That is a legitimate way to work in 2026, and many teams work this way. It is **not** the same as "I typed every line", and you must not say that. It is also not "the AI did everything and I do not understand it", and by the end of this guide it should not be true.

## 3. Which parts are yours to claim, and which are not

Use this table as a starting point, then adjust it to what is true for you. Do not claim a decision you cannot explain.

| Area | Safe to say | Do not say |
|---|---|---|
| Requirements and scope | "I defined the product rules: roles, consent, UTC and timezones, never-twice and never-missed, no real SMS." | "I invented every technical detail." |
| Stack choice | "I chose Django, DRF, PostgreSQL, Celery and Redis, JWT." (it is in the brief) | |
| Reliability design | "The design uses constraints, row locks, leases and idempotent tasks. I can explain each and why." | "I came up with the lease token approach alone", unless you did |
| Index and performance work | "I asked for measured evidence; the numbers are real and reproducible." | "I tuned the indexes by hand" |
| Code | "An AI assistant wrote most of the code under my direction; I reviewed it and can walk through it." | "I wrote it myself" |
| Debugging | "I raised the CI failure, asked for root cause and repeated runs as proof." | |
| Tests | "Tests were required for every feature; I can explain what they protect." | |

The point of the right-hand column is not shame. It is that each of those statements fails the first follow-up question.

## 4. Questions you should be able to answer yourself

If you can answer these without looking, you can defend the project. If you cannot, study the chapter listed.

1. Why are timestamps stored in UTC and schedules in local time? (Ch 6)
2. What stops two workers sending the same reminder? (Ch 7)
3. What happens if a worker dies mid-send? (Ch 7)
4. Why is delivery at-least-once and not exactly-once? (Ch 7, 17)
5. How does a caregiver get access and how is it revoked? (Ch 9)
6. What does the adherence percentage mean? (Ch 10)
7. What did the index work achieve, and how was it measured? (Ch 11)
8. What are the project's main limitations? (Ch 16)

A useful test: close the guide and explain questions 2 and 3 on paper with a diagram. If you can, you understand the heart of the system.

## 5. The honest answer to "Did you write this yourself?"

Short version, about 15 seconds:

> "I directed it. I wrote the requirements and constraints and used an AI coding assistant, Claude Code, to implement them. I reviewed the result, made the product and design decisions I describe, asked for evidence like repeated test runs and query measurements, and I can walk you through any part of it."

Only keep sentences that are true for you. If you did not review a part, do not say you did; go and review it now, and then it is true.

Longer version, for when the interviewer asks to dig in:

> "The brief and the rules were mine: the stack, UTC with per-patient timezones, the never-twice-never-missed rule, the consent model, and no real SMS. The assistant wrote the code and tests in stages: skeleton, accounts, scheduling, the reminder pipeline, reports, then the frontend. When CI failed on Python 3.12 I asked for the root cause rather than a quick fix, and we found a race in how Celery's eager mode saves and restores a flag, which I can explain. I then studied the code so I could explain it, and wrote down the design decisions and limitations. For example, I can tell you why a claimed reminder carries a lease token and what the one remaining duplicate window is."

If you can truthfully add [something you personally changed, decided or fixed], add it. Specific personal details are more convincing than any general claim, but only if they are real. The history above gives you a list of candidates; check each against your own memory of what you asked for.

## 6. Handling the follow-ups

**"So can you code without AI?"** Answer truthfully about your own skill. A good honest line: "I am a fresher and I use AI tools the way many developers do. I am strengthening my fundamentals, which is why I studied this system line by line. I can write [the things you really can] unaided." Do not overstate. If a live coding round follows, they will see.

**"What did the AI get wrong?"** This is a good question to have a real answer for. Real examples from this project's own history: a test that depended on database statistics and passed or failed by luck, fixed in commits `20a5e92` and `6b72e1d`; a hidden race in the Celery test guard that only Python 3.12 timing exposed, fixed in `013676b`; a README claim about running tests without Redis that is not fully accurate. Showing that you found and corrected problems demonstrates judgement.

**"How did you verify the AI's work?"** Tests (460 backend, 450 frontend), coverage with a floor, a CI matrix, mutation experiments (break the code on purpose and check that a test fails), EXPLAIN measurements on a million-row table, and repeated runs to prove stability.

**"Would you use AI at work?"** Yes, with the same discipline: you remain responsible for correctness, security and privacy, you review, you test, and you do not paste secrets or real patient data into a tool.

**"Is it secure and compliant?"** Do not claim compliance. Say what it does (consent model, audit log, rate limits, no secrets in code, privacy-aware logging) and that it has not had a security audit or legal review, and list the gaps from chapter 16.

## 7. Your own fill-in sheet

Write this by hand. The act of writing it is the preparation. Fill every line with something that is true.

* The three product rules I set that I care most about: ______
* One decision I made and why: ______
* One time I rejected, changed or questioned something the AI proposed: ______
* One thing I found by running or reading the code myself: ______
* The part of the system I understand best: ______
* The part I am still weakest on, and my plan: ______
* What I would do differently next time: ______

If a line is empty, that is useful information: it tells you where to practise before the interview. Do not invent text to fill it.

## 8. A note on integrity beyond interviews

* If an application form or a company asks you to disclose AI assistance, disclose it.
* If an assessment forbids AI help, this project is not a substitute for taking it yourself.
* Keep the `Co-Authored-By` trailers in the history. They are accurate and removing them would be misleading.
* Never present measured numbers you did not obtain. The numbers in this guide came from runs in this repository, and they can be reproduced.

## Interview questions on this chapter

1. **Q: Did you write this project yourself?**
   **A:** I directed it. I set the requirements and constraints and used an AI coding assistant to implement them, then reviewed the results, asked for evidence such as test runs and measurements, and I can walk through any part. (Say only what is true for you; the commits carry the AI co-author trailer, so it is open.)

2. **Q: What part did you personally decide?**
   **A:** Name decisions that are in the brief: the stack, UTC storage with per-patient IANA timezones, never twice and never missed, the consent model, email as the channel with an interface for others, and no real SMS or WhatsApp. Then add any specific choice you really made.

3. **Q: What did the AI get wrong, and how did you find out?**
   **A:** Pick real examples: the planner-dependent index test that flaked, the unlocked flag race that failed only on Python 3.12, and the README Redis statement. Say they were found by tests, CI and review, which is the point of having them.

4. **Q: How do you verify code you did not type?**
   **A:** Tests at several levels, coverage with a CI floor, real-thread concurrency tests, mutation experiments, EXPLAIN measurements and repeated runs. Reading and explaining it back is part of verification too.

5. **Q: Could you rebuild this without the assistant?**
   **A:** Answer honestly about your current level. A truthful form is: not as quickly, and not all of it today, but I understand the design and could implement the core parts, and I am studying to close the gaps.

6. **Q: Is using AI to write code cheating?**
   **A:** Not when it is allowed and disclosed, and the person stays accountable for the result. It would be dishonest to claim sole authorship or to use it where it is forbidden.

7. **Q: What would you do differently next time?**
   **A:** Review each stage as it is built instead of afterwards, write the decision log as I go, and have someone else read the security-sensitive parts.

8. **Q: How do you handle sensitive data when using AI tools?**
   **A:** Never put real patient data or secrets into prompts or the repository. The project uses placeholders in `.env.example` and seed data for demos.

## Common mistakes to avoid

* Saying "I wrote everything myself" when you did not. It fails the first follow-up.
* Being so apologetic about AI use that you undersell the real work of directing and verifying it.
* Claiming decisions you cannot explain.
* Claiming security or regulatory compliance the project has not been audited for.
* Inventing a personal story to sound more impressive; use the fill-in sheet with only true statements.
* Hiding the co-author trailers or the limitations.

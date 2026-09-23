# Incident 2026-09 — raw credential tokens in email idempotency keys

Before commit `6115b9c`, `EmailService` used `invite:<rawToken>` /
`reset:<rawToken>` / `verify:<rawToken>` as the email idempotency key. That key
was stored in `email_logs.idempotency_key`, became the BullMQ job id (Redis key
names and the `bull:email:events` stream) and was printed by `QueueService`
(`enqueued email.send job=…`) into the API's Railway logs. The code now hashes
the token first; these scripts clean up what was already written.

Every script prints **counts only** and defaults to a **dry run**.

| # | Script | Where it runs | Changes (apply mode only) |
|---|---|---|---|
| 1 | `01_readonly_assessment.sql` | any psql client | none — read-only transaction |
| 2 | `02_remediation.sql` | psql, `-v apply=1` to commit | `password_resets.expires_at = now()` for leaked, still-usable tokens; masks raw `email_logs` keys to `redacted-<prefix>:sha256(tail)` |
| 3 | `03_redis_cleanup.js` | inside the worker container (`railway ssh`), `APPLY=1` to act | removes COMPLETED/FAILED email jobs whose id is a raw token; XDELs their `events` entries |

## Order

1. Run **01** and compare with the counts in the incident report.
2. Run **02** without `apply`; review the counts and the `Verification passed`
   notice. Then run it with `-v apply=1`. It aborts on its own if the targets
   exceed the reviewed numbers (2 tokens, 7 keys).
3. Run **03** without `APPLY`; review. Then with `APPLY=1`. It never touches a
   waiting/active/delayed job.
4. Run **01** again: section 2 must show no `ACTIVE — LEAKED` row.

Tested against a disposable PostgreSQL 18 (dry run leaves data unchanged; apply
invalidates exactly the leaked active tokens, preserves every other token,
deletes no row; a second apply changes nothing; the guard aborts on drift) and
a local Redis with real BullMQ jobs (pending raw-id job and hashed-id jobs kept;
second apply removes nothing).

## After applying

Clinics resend the affected invitations from the staff page — the leaked ones
now show as `invitation_expired`. Railway logs cannot be edited line by line;
the logged tokens are worthless once step 2 is applied and age out with the
plan's log retention.

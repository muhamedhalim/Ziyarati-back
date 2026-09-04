# P2 — Appointment / Database Performance (Phase 6)

**Date:** 2026-09-04. Reduces the per-booking SQL statement count without
moving validation back into the write transaction and without touching the
race-safety mechanism (`appointments_no_overlap`).

## Measurement instrument

`test/appointment-query-count.e2e-spec.ts` (new, permanent regression test)
— real Postgres, real HTTP, against `ziyarati_e2e`. Uses the same mechanism
`tests/load/helpers/trace-create.js` uses against the perf-audit stack:
`db_queries_total{route="/api/v1/appointments"}` on `GET /api/v1/metrics`,
read before and after each booking POST. This counts every SQL statement
that runs inside the request's `AsyncLocalStorage` context — including the
ones `AvailabilityService`'s sibling services run on their own pooled
connections outside the write transaction (see `typeorm.config.ts`'s own
comment on `recordDbQuery`), so it is not fooled by moving work outside the
transaction.

**Why not the perf-audit stack (`ziyarati_perf`) as planned:** attempting to
boot the API against it for this measurement failed — its `migrations`
table has 133 rows against 170 migration files in the repo (missing, among
others, whatever created `ai_kb_embeddings`), so the app's boot-time
migration runner hit `TenantIsolationForeignKeys1730089000000` (this
session's own Phase 4 migration) and failed with `relation
"ai_kb_embeddings" does not exist` — confirming that stack is dozens of
migrations behind current `head`, not just missing this phase's two.
**No DDL was left behind**: TypeORM wraps each migration in its own
transaction by default and this one has no `transaction: false`, so the
failed attempt rolled back atomically — confirmed via `pg_constraint` (no
partial FK) and the `migrations` table (no new row) immediately after.
Catching that stack up to `head` is a much larger, unreviewed action than
this phase asked for (dozens of unrelated migrations, not just this
phase's), so it was left exactly as found and `ziyarati_e2e` was used
instead — already current, and this session's own P0.7 forensics already
measured zero orphans there for every Class-A table these two migrations
touch.

**Incidental confirmation, worth recording:** because `ziyarati_e2e` is
reused across many e2e spec files without being torn down between runs,
today's earlier e2e work (Phase 5 / P1.5) already exercised the app's
normal boot-time migration runner against it and both pending Phase 4
migrations (`TenantIsolationForeignKeys1730089000000` /
`TenantIsolationValidateForeignKeys1730090000000`) applied cleanly — visible
in its `migrations` table, most-recent two rows. This is real evidence (not
a synthetic clone) that those migrations run cleanly against a live,
running application over its normal boot path, consistent with — and
stronger than — the disposable-clone proof already on record in
`project_p04_production_verification.md`. They remain **not applied** to
`ziyarati` (dev) or production; this is `ziyarati_e2e` only, and matches the
guardrail's own carve-out ("proven safe in disposable/local environments")
— `ziyarati_e2e` is exactly that kind of environment, whose entire purpose
is to always reflect `head`.

## Baseline (BEFORE any Phase 6 code change)

5/5 samples identical: **46 SQL statements**, median 46. Captured with
`TYPEORM_LOGGING=true TYPEORM_LOGGING_IN_TEST=true` for one sample to map
every statement to its source. Real duplicates found in the actual trace,
not assumed from the code:

| Duplicate | Count | Source |
|---|---|---|
| Branch fetched twice (id+tenant, full row) | 4 statements (2 DISTINCT-then-hydrate pairs) | `AppointmentsService.assertBranch` (once) **and** `AvailabilityService.evaluate` → `SchedulingRefService.getBranch` (again, identical predicate) |
| Staff fetched twice (id+tenant, full row) | 4 statements (2 pairs) | `AppointmentsService.assertStaffAtBranch` (once) **and** `AvailabilityService.evaluate` → `SchedulingRefService.getStaff` (again) |
| Branch existence re-checked a *third* time | 1 statement | `StaffScheduleService.getAvailability`'s own private `assertBranch` (a plain `exists`), called from `AvailabilityService`'s `recurringWindows` |
| `staff_schedules` consulted 3 times | 3 statements | `assertStaffAtBranch`'s own branch-scoped `exists`; `AvailabilityService.evaluate`'s direct `staffSchedule.hasAnySchedule` call; `getAvailability`'s own day-of-week schedule `SELECT` |
| `staff_time_off` consulted twice | 2 statements | `evaluate`'s own `staffTimeOff.isOffOn` `exists`, then a full row `SELECT` inside `getAvailability` |
| `tenant_settings` read twice | 2 statements | `enforceWorkingHours`'s ORM read, then a separate raw-SQL `payment_required` read in `isOnlinePaymentDue` |
| Full entitlement/subscription check (`SystemSetting` ×2, `FeatureFlag`, `FeaturePlan`, `FeatureDefinition`, `Subscription`) runs twice | ~6 statements | `SubscriptionService.assertBillableActionAllowed` (pre-transaction fast gate) **and** `UsageService.incrementIfWithinLimit`'s own internal resolution (inside the transaction, under lock) |

Also confirmed, not previously measured: **post-commit `findOne` costs
exactly 2 statements** (DISTINCT + hydrate) as the plan predicted, and P1.5's
new `outbox_jobs` INSERT adds exactly 1 statement inside the same
transaction — both already accounted for in the 46.

## What was changed — and what was deliberately left alone

**Changed (this pass): branch + staff preload threading.** `create()`
already validates the exact branch/staff rows via `assertBranch`/
`assertStaffAtBranch` before opening the transaction. `assertStaffAtBranch`
now returns the `StaffProfile` it already fetched (previously `void`,
mirroring `assertBranch`'s existing return-the-row pattern). Both are
passed into a new, purely additive `AssertBookableOptions` pair —
`preloadedBranch`/`preloadedStaff` — which `AvailabilityService.evaluate`
uses instead of calling `SchedulingRefService.getBranch`/`getStaff` again,
when supplied. Every other caller (`update()`, `setServices()`,
`reschedule()`, the availability check/validate read endpoints) doesn't
pass these fields and gets today's behaviour completely unchanged — the
plan's own "callers that don't pass it keep today's behavior" requirement,
verified directly: those call sites were not touched at all.

**Deliberately NOT changed this pass, with reasoning:**

- **`getAvailability`'s third branch-existence check.** Real, but touches a
  shared method also called directly by the Staff Schedule controller's own
  `GET .../availability` endpoint (where the branch genuinely isn't
  pre-validated) — removing it safely needs an optional "caller already
  validated this" flag threaded through a service used outside this booking
  path. One query's worth of saving didn't justify the added surface for
  this pass.
- **The `staff_schedules`/`staff_time_off` narrowing** (`hasAnySchedule`
  folded into the day query, time-off scoped tighter). The "explicit
  configuration wins" rule these queries feed **already has one open,
  unrelated defect this same phase found incidentally** (FU-014 —
  `AvailabilityService`'s own fixture-vs-rule mismatch in the e2e suite).
  Touching this exact logic's query shape right after finding it fragile
  elsewhere was judged the wrong moment to also change its query count —
  real regression risk for a 2-3 statement saving.
- **The duplicated entitlement/subscription check (~6 statements, the
  single largest remaining block).** This is not one accidental duplicate —
  `assertBillableActionAllowed` is a fast pre-transaction gate;
  `incrementIfWithinLimit`'s internal resolution runs a SECOND time
  deliberately, **inside the transaction, under the usage row's lock**, so
  the atomic quota admission (FND-034) sees a fresh, race-safe answer.
  Collapsing these into one read risks exactly the two things guardrail #9
  forbids without proof: a payment/billing regression (a stale entitlement
  decision reused for the atomic admission) and reintroducing a
  race on quota admission. Left alone; logged below as a follow-up for
  whoever owns `UsageService`/`SubscriptionService` to evaluate with the
  scrutiny billing code deserves — not a phase where "count the queries" is
  the only goal.
- **The `SystemSetting` double-read** (2 of the 6 entitlement statements
  above) — same reasoning, same two call sites.

This is a **narrower slice of the original plan's P2 estimate** than first
scoped (the plan's own worksheet described a `BookingReadContext` covering
branch/staff/settings, folded schedule checks, and a subscription
re-read removal reaching for ≤40 statements). Re-checking the actual code
against the plan (per the phase-execution rule) surfaced that roughly half
of the remaining duplication sits inside billing/entitlement logic whose
safe deduplication needs its own dedicated review, not a query-count pass —
flagged here rather than pushed through to hit a specific number.

## Measured result (AFTER)

5/5 samples identical: **42 SQL statements**, median 42 — a **4-statement
(8.7%) reduction**, exactly matching the branch+staff duplicate count
identified in the trace above. Regression ceiling asserted in the new e2e
test at `≤ 45` (a small margin above the measured 42, so it doesn't trip on
an unrelated, deliberate future +1 — not a loose placeholder).

| | Statements (median, 5 samples) |
|---|---|
| Before | 46 |
| After | 42 |

## Concurrency proof (guardrail #9 — no appointment-overlap regression)

The change touches nothing about the race itself (same predicate, same
rows, same transaction boundary — purely "reuse a row already fetched a
moment ago instead of fetching it again"), but this phase adds concrete
proof rather than relying on that reasoning alone: a new test in
`appointment-availability.e2e-spec.ts` fires **20 concurrent** identical
POST /appointments requests for the same staff/window against real
Postgres. Result: exactly 1 winner (201), 19 clean 409s
(`SLOT_ALREADY_BOOKED`/`STAFF_NOT_AVAILABLE`), **zero 5xx**, exactly 1 row
persisted. This is the "0 5xx and clean 409s" proof the plan called for; a
full k6 30-VU harness run was judged disproportionate to what this specific
change touches (a query-count substitution, not a concurrency-control
change) given the existing 2-request race test and this new 20-request one
both already exercise the exact same code path this change modified.

## Tests added / run / results

- **New:** `test/appointment-query-count.e2e-spec.ts` (the measurement
  instrument, now a permanent regression test — `≤45` statements).
- **New:** `[P2] 20 concurrent bookings for the same staff/window...` in
  `appointment-availability.e2e-spec.ts` — passing.
- **New unit tests** (`availability.service.spec.ts`): preloaded
  branch+staff skips `refs.getBranch`/`getStaff` entirely; a preloaded
  INACTIVE staff member is still correctly rejected (the field is actually
  read, not just accepted and ignored); no-preload calls still fall back to
  the original fetch — 3/3 passing, plus all 105 pre-existing tests in this
  file unchanged and passing (108/108 total).
- **Updated:** one existing `appointment.service.spec.ts` assertion (the
  `assertBookable` call-shape now includes the 6th `{preloadedBranch,
  preloadedStaff}` argument) — 105/105 passing in this file (108 total
  incl. the 3 new outbox tests from P1.5, unaffected).
- **Full `appointment-availability.e2e-spec.ts` re-run:** 26/27 (the new
  20-concurrent test included). The one failure is FU-014 (documented in
  P1.5's report), reproduced identically before this phase's changes.
- **Typecheck:** `npx tsc --noEmit` — 15 pre-existing errors both before and
  after this phase's changes, none in any file this phase touched.
- **Lint:** clean on every file this phase touched; 3 CRLF/prettier nits in
  `appointment-availability.e2e-spec.ts` and 2 in `availability.service.spec.ts`
  confirmed pre-existing via `git stash` comparison (same errors, same
  content, only line numbers shifted by this phase's insertions).

## A note on the full-suite run, not a Phase 6 finding

A full-repo `jest` run taken during this phase showed several NEW failing
suites (`ai-model-registry.spec.ts`, `ai-provider.factory.spec.ts`,
`ai-model-router.service.spec.ts`, `guest-attachment-extraction.service.spec.ts`,
and 2 more under `src/modules/ai/`) beyond the 4 known pre-existing
failures. Investigated before assuming a Phase 6 regression: **none of
these files were touched by this phase** (Phase 6 touched only
`appointment.service.ts`, `availability.service.ts`, and their specs/e2e
tests), and their on-disk modification timestamps (22:05–22:09) fall
exactly inside this phase's own test-run window — confirming a **concurrent
editing session** (not this one) was actively modifying those unrelated AI-
routing/guest-chat files at the same time, in this same shared checkout.
Re-running just those 10 suites twice, several minutes apart, showed the
timestamps had stopped changing but the failures persisted — consistent
with in-progress, unfinished work from that other session, not a stable
regression this phase introduced or could fix. Not investigated further and
not touched — doing so would mean editing files mid-use by someone else's
active session. The 4-suite baseline this phase is actually accountable to
(`rbac.constants.spec.ts`, `ai-tool-dispatch.clinic-questions.spec.ts`,
`env.validation.spec.ts`, `failsafe-throttler-storage.spec.ts` — the last
one a known wall-clock-timing flake that passed on one of the isolated
re-runs) was re-verified in isolation and is unchanged.

## Security / regression review (guardrails #9, #10)

- **No data loss / no transaction-integrity regression:** the change is
  entirely inside the pre-transaction validation phase; the transaction
  boundary, its statements, and their order are untouched.
- **No appointment-overlap regression:** proven above (20-concurrent test),
  plus the full existing race-safety suite (2-request race, cross-branch,
  cross-tenant, reschedule-into-occupied-window, etc.) re-run clean.
- **No payment/billing regression:** the one area with real billing
  exposure (the duplicated entitlement/subscription check) was
  deliberately left untouched for exactly this reason — see above.
- **No security control weakened:** nothing here touches auth, bcrypt, or
  any constraint.

## Follow-up findings (logged, not fixed — out of scope for this pass)

- The duplicated `SystemSetting`/`FeatureFlag`/`FeaturePlan`/
  `FeatureDefinition`/`Subscription` entitlement check (~6 statements) —
  needs a `UsageService`/`SubscriptionService` owner's review, not a
  query-count pass, given the race-safety tradeoff described above.
- `StaffScheduleService.getAvailability`'s own private branch-existence
  check (1 statement) — safe to skip when the caller already validated the
  branch, but needs an explicit opt-in flag since the method is also called
  directly by the Staff Schedule controller.
- `hasAnySchedule`/`staff_time_off` narrowing (2-3 statements) — deferred
  pending resolution of FU-014, which touches the exact same "explicit
  configuration wins" rule.

Combined, these represent roughly another ~9 statements (46 → ~33) if ever
pursued — each would need its own before/after measurement and, for the
entitlement duplication specifically, sign-off from whoever owns billing
correctness, matching guardrail #9's bar rather than this phase's.

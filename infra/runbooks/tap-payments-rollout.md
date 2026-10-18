# Tap payments — production rollout runbook

Companion to `specs/017-tap-payments/phase-8-production-rollout.md` (the evidence and status of Phase 8). This file is the procedure; it lives in the backend repo so it is versioned with the code, the alarms and the preflight it describes.

**State when written (2026-10-04):** the code for Phases 1–7 is merged on `master`; **nothing is switched on anywhere**. Production runs on Railway today (the AWS target in `infra/` is not applied); the frontend is on Vercel. `PAYMENT_PROVIDER` is unset, and no Tap secret exists in any hosted environment.

> **Stale since 2026-10-18 — verify before acting.** The infrastructure audit notes (`infra/docs/DATA-RESIDENCY.md`, `INFRASTRUCTURE-AUDITS.md`) record a running ECS task definition (`zt-production-api:16`) with `PAYMENT_PROVIDER=tap` and `TAP_ENV=live`, and `environments/production/terraform.tfvars` sets both, while `TAP_MERCHANT_ID` and the live key are still commented out. Read the **actual** environment of the running api and worker tasks (names only) and run the preflight (§4) before trusting the paragraph above. With `PAYMENT_PROVIDER=tap` and no merchant id, subscription checkout is simply not offered and paid plans are refused in production — safe, but visible.

---

## 1. Principles

1. **Ship dark, switch on later.** The release that contains the Tap code must not also change `PAYMENT_PROVIDER`. With the provider unchanged, nothing in the Tap path runs (the reconciliation job reports `tap_not_active`, checkout is capability-gated off, `/pay/*` is not served on a legacy provider).
2. **Three independent switches, in this order, each reversible by setting one variable back:**
   `PAYMENT_PROVIDER=tap` → `TAP_RECURRING_ENABLED=true` → `TAP_BOOKING_PAYMENTS_ENABLED=true`.
   The code is the same at every step.
3. **Money first moves at §5 step 6** (a 1-SAR charge you make yourself, then refund). Nothing before it can charge anyone.
4. **A green preflight is necessary, not sufficient** (see §9).
5. Production stays read-only for anything not written down here. Every SQL in §8 is a `SELECT`.

## 2. Where each setting lives

Set every `TAP_*` variable on **both** the API and the worker service — the worker runs the reconciliation, the renewal charges and the payment-outcome jobs (the 2026-09 email incident was exactly a worker missing a variable).

| Setting | Secret? | Railway (today) | AWS (target, `infra/terraform`) |
|---|---|---|---|
| `PAYMENT_PROVIDER` | no | service variable | `app_environment` in `environments/<env>/terraform.tfvars` |
| `TAP_ENV` (`live` / `sandbox`) | no | service variable | `app_environment` (already declared) |
| `TAP_WEBHOOK_URL` — public **https**, ends `/api/v1/payments/webhooks/tap` | no | service variable | `app_environment` (already declared) |
| `TAP_RECURRING_ENABLED`, `TAP_BOOKING_PAYMENTS_ENABLED` | no | service variable (default `false`) | `app_environment` (declared `"false"`) |
| `TAP_MERCHANT_ID` (dashboard "Merchant ID") | no | service variable | `app_environment` (commented line to enable) |
| `TAP_LIVE_SECRET_KEY` (production) / `TAP_TEST_SECRET_KEY` (sandbox) | **yes** | secret variable | key in the `zt/<env>/app` JSON secret **and** in `app_secret_keys` (commented line to enable) |
| `SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS` (default `7`, `0` = off) | no | service variable | `app_environment` (optional) — days before a never-paid `PENDING_PAYMENT` subscription is cancelled by the daily 02:30 UTC sweep |
| `TAP_PLATFORM_ID` | no | service variable — only for §5 step 9 | `app_environment` — only for step 9 |
| `TAP_SEGMENT_SECRET_KEY` | **yes** | only if Tap issues a separate one | same as the key |

Rules that are enforced at boot (`src/config/env.validation.ts`, covered by tests): a value that IS present is checked — a `sk_live_` key in the test slot (or the reverse) is refused, a production `TAP_WEBHOOK_URL` must be https and not localhost, and `TAP_BOOKING_PAYMENTS_ENABLED=true` needs `TAP_PLATFORM_ID`. **A value that is ABSENT does not stop the boot** (deliberate: an absent Tap variable must never take the whole app down). Tap calls then fail at call time (`no secret key for TAP_ENV`, alarm P-03), and the preflight (§4) is the gate that turns a missing `TAP_ENV`, `TAP_MERCHANT_ID`, active key or webhook URL into a failure.

**A paid plan is never activated without a checkout provider** (any environment, any billing mode): with Tap unset or unconfigured, `POST /subscriptions`, change-plan and reactivate return 422 "online payment is not available", `/billing/payment-method` reports `checkoutAvailable:false`, and a live deployment (NODE_ENV=production) logs `ALERT: PAYMENT_PROVIDER=tap but subscription payments are unavailable — missing …` once at startup, naming the missing setting (never a value) (P-01). Only NODE_ENV=test, or `SUBSCRIPTION_ALLOW_UNPAID_STUB=true` outside production, lets a paid plan skip payment.

`TAP_MERCHANT_ID` is ZiyaraTech's **own** merchant id. Every subscription charge is sent with it and is only booked when Tap echoes the same id back (otherwise the charge is held and an `ALERT:` line is logged, P-01) — so it is required for subscription payments, not optional. The `TAP_*_PUBLIC_KEY`, `TAP_DOMAIN_*` and `TAP_BUNDLE_*` names that may exist in a developer `.env` are **not read by any code** (hosted checkout needs no public key); do not deploy them.

Production carries **only** the live key; staging only the test key. Never put both in one environment.

**Storing the key without leaking it** (AWS; `put-secret-value` replaces the whole JSON, so read–modify–write, and never type the key on a command line):

```bash
read -rs TAP_KEY && export TAP_KEY            # paste the key, nothing is echoed
SECRET=zt/production/app
NEW=$(aws secretsmanager get-secret-value --secret-id "$SECRET" --query SecretString --output text \
      | jq --arg k "$TAP_KEY" '. + {TAP_LIVE_SECRET_KEY: $k}')
aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "$NEW"
unset TAP_KEY NEW
```

ECS reads the secret when a task **starts**, and Terraform never restarts services — after changing a secret or env, run the deploy workflow (or force a new deployment) to roll the tasks. On Railway, changing a variable redeploys the service.

## 3. Go / no-go gates

A step may start only when every gate it depends on is satisfied. Status as of 2026-10-04:

| # | Gate | Needed for | How to verify | Status |
|---|---|---|---|---|
| G1 | A real captured Tap charge, refunded, and the return-URL behaviour seen (Phase 7 step 1: `scripts/tap-sandbox/pay.js`, a human types the Tap test card) | §5 step 5 | `phase-7-sandbox-validation.md` §6 | **OPEN** |
| G2 | A real signed webhook delivery verified (Phase 7 step 2: `webhook-capture.js` + a tunnel — or a staging environment with a real https URL) | §5 step 5 | the capture reports `MATCH`; or `webhook_logs` shows a `verified` row | **OPEN** |
| G3 | The live account accepts a live charge for the platform merchant | §5 step 6 | step 6 itself; the preflight `tap-auth` only proves the key authenticates | **OPEN** (unknown) |
| G4 | The frontend release with `/pay/[token]`, `/pay/return` and the billing return handler is deployed | §5 step 5 | preflight `frontend` = PASS | **OPEN** |
| G5 | Migrations M1–M5 applied on the production database, a snapshot taken first, and rehearsed on a restore | §4 | `node dist/src/migrate.js show`; the chain was proven from empty on 2026-10-04 (155 migrations) | **OPEN** (operator) |
| G6 | The §7 alarms exist and every alert address has clicked its confirmation link | §5 step 5 | AWS: apply `environments/<env>`; Railway: an equivalent log alert on the same strings (§7) | **OPEN** |
| G7 | Read-only production counts recorded: `SELECT gateway, status, count(*) FROM payments GROUP BY 1,2` and `SELECT provider, status, count(*) FROM merchant_accounts GROUP BY 1,2` (also decides Phase 9) | §4 | §8 query 0 | **OPEN** |
| G8 | Decision on **add-on refunds** (a clinic owner's `POST /refunds` on an add-on payment debits ZiyaraTech's wallet under Tap): (a) leave, (b) platform-admin only, (c) owner requests + platform approves | §5 step 7 | recorded in the Phase 8 doc | **OPEN** |
| G9 | **Save Card + non-3DS merchant-initiated charges** activated by Tap on the live account | §5 step 8 | Tap's written confirmation | **OPEN** |
| G10 | **Platform activation** and `TAP_PLATFORM_ID`; Tap's answer to "what `merchant.id` does a platform charge echo for a clinic?" | §5 step 9 | `phase-0-prerequisites.md` §3 questions | **OPEN** |

G9 and G10 do **not** block steps 1–7: subscriptions and add-ons are charged on the platform's own merchant, and with `TAP_RECURRING_ENABLED=false` the first charge simply does not save the card (renewals show the existing "pay now" banner).

## 4. Step 0 — ship the code dark

1. Snapshot the production database (AWS: manual RDS snapshot; Railway: backup). Rehearse the migrations on a restore of it.
2. Deploy the backend (API **and** worker) and the frontend with `PAYMENT_PROVIDER` unchanged. Migrations M1 → M5 run first (`node dist/src/migrate.js run`); all five are additive with defaults, so an automatic rollback to the previous image is safe.
3. Deploy off-peak: during the roll an old worker could consume a `payments.outcome` job as a no-op; the in-process fast path still applies the entitlement, so a payment captured in that window is not lost.
4. Verify:
   - `node dist/src/migrate.js show` lists `PaymentsFinanceClassification…` to `PaymentsReconciliation…` as applied.
   - Preflight, no flags → `TAP_PREFLIGHT_OK`, `provider SKIP`, `frontend PASS`.
   - The worker log shows its repeatable jobs registered (`payments.providerReconcile` daily 03:00 and weekly Sunday 04:00); it must do nothing yet.
   - §8 queries 1–3 return no rows.

**What changes in production on day 0 even though the provider is unchanged** (all intended fixes, none gated):

| Change | Effect you may notice |
|---|---|
| Settlement run claims only clinic booking/manual payments | Add-on / billing-upgrade payments (platform revenue) stop appearing in clinic settlement batches. §8 queries 4–5 list any an earlier run already claimed — they are never auto-corrected. |
| A late `paid` event can no longer flip a refunded payment back to PAID | none visible |
| `payments.outcome` outbox job applies the booking / add-on / upgrade consequence in the worker | add-on and upgrade grants survive a lost in-process event |
| Renewal bills the **next** period (the first renewal of a paid subscription used to be skipped and drift to `GRACE_EXPIRED` with no invoice) | a renewal invoice now appears and, with no card on file, the existing "pay now" banner; it cannot be paid in-app until step 5 (as before: the old provider's `/pay` always answered 422 in production) |
| Clinic `/app/payments` omits the clinic's own add-on / upgrade payments by default; rows gain `purpose` / `settlement_mode` | additive |
| Finance UIs: new platform screens (merchants, reconciliation, subscription ledger) | additive; reconciliation finds nothing until the provider is `tap` |

If a staging environment exists, rehearse §5 steps 2–6 there first on **sandbox** keys (`TAP_ENV=sandbox`, `TAP_TEST_SECRET_KEY`, test cards `4508750015741019` exp `01/39` approve / `05/22` decline). A staging environment with a real https URL also closes gate G2 without a tunnel.

## 5. Production steps

Each step ends with a **pass criterion**; do not continue until it holds.

**1. Gates.** G1–G8 satisfied (G9, G10 only for steps 8 and 9).

**2. Store the live key** (§2). Do not list it anywhere else, and do not set `PAYMENT_PROVIDER` yet.
*Pass:* the secret/variable exists; `git grep sk_live_` in both repos finds only fake test fixtures.

**3. Stage the rest of the configuration** before the first deploy: `TAP_ENV=live`, `TAP_WEBHOOK_URL`, both flags `false`, `TAP_MERCHANT_ID`. AWS: uncomment `TAP_MERCHANT_ID` and `TAP_LIVE_SECRET_KEY` in `environments/production/terraform.tfvars` (**only after step 2**), apply, roll the tasks.
*Pass:* both services start and are healthy.

**4. Pre-flip preflight.** Run the preflight against the exact post-flip configuration by overriding the provider for that one task only:

```bash
# Railway: run in a shell of the API service      AWS: run-task with an environment override
PAYMENT_PROVIDER=tap node dist/src/tap-preflight.js --expect-active --expect-env=live --expect-flags-off --probe-webhook
```

(AWS `--overrides`: `{"containerOverrides":[{"name":"api","environment":[{"name":"PAYMENT_PROVIDER","value":"tap"}],"command":["node","dist/src/tap-preflight.js","--expect-active","--expect-env=live","--expect-flags-off","--probe-webhook"]}]}` — full command in `DEPLOYMENT.md` §11.)
*Pass:* `TAP_PREFLIGHT_OK` with **no FAIL** and ideally no WARN. Specifically `env-validation`, `tap-key`, `tap-auth`, `webhook-url`, `frontend`, `webhook-signed` and `webhook-unsigned` are PASS. The probe leaves one `FAILED` row in `webhook_logs` (`charge.captured`, "Re-fetch failed") and two log lines (`could not be re-fetched`, `Rejected Tap webhook`) — expected, and below every alarm threshold.

**5. Flip the provider.** Set `PAYMENT_PROVIDER=tap` on API and worker (AWS: edit the tfvars line, apply, roll). Re-run the preflight **without** the override and **without** `--probe-webhook`.
*Pass:* `TAP_PREFLIGHT_OK`; a super admin can open `/platform/finance/transactions`, `/platform/finance/reconciliation` and `/platform/finance/merchants`; `GET /api/v1/platform/payments/metrics` answers.
From this moment a new paid subscription goes to Tap's hosted page and stays `PENDING_PAYMENT` until it is paid (D2). Announce it.

**6. Live 1-SAR smoke — yourself, with your own card.** Use an internal tenant and the cheapest purchasable item (create a 1.00 SAR "smoke" plan in the platform catalogue if none exists; archive it afterwards). Subscribe, pay on Tap's page, return to `/app/billing`.
*Pass — all of:*
- `webhook_logs` has a `tap` row with status `verified`/`processed` for the charge (**this settles Tap's real `hashstring` algorithm, the webhook response and the retry behaviour**; a `rejected` row means our formula differs from Tap's — payments still settle through the return-page verify and the 10-minute sweep, but stop here and fix it);
- the invoice is PAID and the subscription ACTIVE, with the period counted from the payment;
- the return URL carried `tap_id` and the billing page showed "paid";
- then refund it from the Platform finance subscription ledger (`POST /platform/billing/invoices/:id/refund`): the refund reaches SUCCEEDED and Tap's dashboard shows it. Expect to lose Tap's processing fee on this charge (refund fee return depends on the merchant agreement).
Record what you saw in the Phase 8 doc (hashstring: match/mismatch, webhook response code, query string on the return URL, the fee Tap kept).

**7. Open it to clinics (subscriptions and add-ons).** Decide G8 first. Watch §7 closely for the first 24 hours.
*Pass:* the first real clinic payment settles (invoice PAID, subscription ACTIVE) with no alarm.

**8. Recurring renewals** — `TAP_RECURRING_ENABLED=true`, only after G9 and only when one internal tenant has paid with "save card" on live. Then force that tenant's renewal (a reviewed single-row change of its period end, then the `subscriptions.renewalBill` job, or wait for 02:15).
*Pass:* the renewal settles with no clinic interaction. Until then the flag stays `false`; with it `true` and Save Card not activated, Tap answers `1108` on the first charge — which is exactly why the code sends `save_card:false` while the flag is off.

**9. Booking payments, per clinic** — needs G10. Onboard one clinic (`/app/payments` → Connect with Tap; a super admin reviews and approves with the merchant id), set `TAP_PLATFORM_ID`, then `TAP_BOOKING_PAYMENTS_ENABLED=true`. Make a 1-SAR booking payment for that clinic and refund it. `TAP_ROUTED_TO_PLATFORM` / alarm P-02 must stay silent: it means Tap put a clinic charge on ZiyaraTech's own account (the charge is refused and no pay link is handed out).
*Pass:* the money shows on the clinic's merchant, not ours; the appointment is confirmed; the refund completes.

## 6. Rollback

Always possible by changing one variable; never delete a row. **Keep the Tap webhook route deployed, the key and `TAP_ENV` in place** through any rollback — charges already created keep posting to it and still settle.

| Situation | Action | Effect |
|---|---|---|
| Any doubt about live money | `PAYMENT_PROVIDER=noop` (API + worker) | no new charges anywhere; the app still boots; in-flight charges still settle via webhook/sweep |
| Booking only | `TAP_BOOKING_PAYMENTS_ENABLED=false` | bookings confirm as pay-at-clinic, links stop being issued, `/pay/*` reads "unavailable" |
| Renewals only | `TAP_RECURRING_ENABLED=false` | renewals show the "pay now" banner |
| Bad release | redeploy the previous image (AWS: the ECS circuit breaker does it; Railway: redeploy) | migrations are additive, the old image ignores the new columns |
| `PENDING_PAYMENT` subscriptions left after a provider rollback | a reviewed script, not part of any release: cancel them and void their OPEN invoices (Phase 3 doc §7) | paid rows are never touched |
| Wrong key / revoked key | fix the secret, roll, re-run the preflight | until then payments fail closed with a generic message |

## 7. Monitoring

AWS: created by `infra/terraform/modules/monitoring` (log metric filters + alarms + a dashboard widget), routed to the existing alert topic. **Railway has no CloudWatch — create equivalent alerts on the same log strings** (they are pinned by `src/modules/payments/preflight/tap-alert-log-lines.spec.ts`, which fails if a message is reworded).

| Alarm | Fires when | Means | First action |
|---|---|---|---|
| P-01 `critical-payments-alert` | any `ALERT:` line in 15 min | a money-state exception: duplicate capture, a reconciliation exception, an exhausted `payments.outcome` job, a stuck refund, a charge captured on a void invoice, **a subscription charge not routed to the ZiyaraTech merchant** (`subscription charge … was NOT routed to the ZiyaraTech merchant`), **a capture whose amount/currency is missing or wrong** (`invoice …: tap captured …`), **a subscription charge unresolved for over 24 h** (`unresolved provider charge for over 24 hours`) | open `/platform/finance/reconciliation`; §8 queries 6–9 |
| P-02 `critical-tap-misrouted-charge` | any `was NOT routed to the clinic merchant` | Tap put a clinic charge on our own account, or named no merchant — refused, no link issued | check the clinic's merchant id and the platform routing; do **not** re-enable until understood |
| P-03 `critical-tap-not-configured` | any `no secret key for TAP_ENV` | a Tap call was skipped: no key for the active `TAP_ENV` | run the preflight; fix the secret |
| P-04 `warning-tap-webhooks-rejected` | ≥ 3 `Rejected Tap webhook` / 15 min | bad signature: secret mismatch after a rotation, or probing | compare the key on API and worker; payments still settle via return verify + the 10-minute sweep |
| P-05 `warning-tap-webhook-refetch-failed` | ≥ 3 `could not be re-fetched` / 15 min | correctly signed deliveries for charges Tap will not show us: wrong environment/account, or a clinic charge our platform key cannot read | check `TAP_ENV` and the merchant; for clinics see `provider_reports_status` |
| P-06 `warning` / `critical-tap-api-unavailable` | > 5 / > 30 calls per 5 min for 10 min | Tap unreachable or timing out (outcomes stay `unknown`, never `failed`) | Tap status page; NAT egress |

Not covered by an alarm (no log line to key on): the daily reconciliation job not running, and the daily `subscriptions.pendingPaymentExpiry` sweep (02:30 UTC; heartbeat `subscriptions.pendingPaymentExpiry`, log `pendingPaymentExpiry: scanned=… cancelled=…`). Check them each morning (below).

**Daily for the first 14 days (10 minutes):**
1. `/platform/finance/reconciliation?status=OPEN` is empty or understood; resolve/ignore each row with a note.
2. §8 queries 6–10 return nothing unexpected.
3. `/platform/finance/transactions` → Tap payments older than a day show `RECONCILED` fees (a `PROVISIONAL` row after a week means the report was unreachable — import the CSV, Phase 5 doc §7).
4. The worker log shows `provider reconcile (3d): merchants=… exceptions=…` from 03:00 UTC.

## 8. Read-only SQL

`created_at` on `payments` and `refunds` is `timestamp without time zone`: compare it **in SQL** like below, never in application code.

```sql
-- 0. what payment-provider history exists (gate G7, Phase 9 decision)
SELECT gateway, status, count(*) FROM payments GROUP BY 1,2 ORDER BY 1,2;
SELECT provider, status, count(*) FROM merchant_accounts GROUP BY 1,2 ORDER BY 1,2;

-- 1. outcome rows: stuck PENDING (relay down?) or FAILED
SELECT status, count(*), min(created_at) AS oldest
FROM outbox_jobs WHERE job_name = 'payments.outcome' GROUP BY status;

-- 2. captured add-on / upgrade payments whose consequence never applied
SELECT 'addon' AS kind, p.id AS payment_id, p.paid_at, r.status
FROM payments p JOIN resource_purchases r ON r."paymentId" = p.id
WHERE p.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND r.status = 'payment_processing'
  AND p.paid_at < now() - interval '15 minutes'
UNION ALL
SELECT 'upgrade', p.id, p.paid_at, b.status
FROM payments p JOIN billing_upgrade_requests b ON b."paymentId" = p.id
WHERE p.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND b.status = 'payment_processing'
  AND p.paid_at < now() - interval '15 minutes';

-- 3. an invoice that is PAID but whose subscription never left PENDING_PAYMENT
-- (subscription_invoices.subscription_id / tenant_id are varchar: join as text)
SELECT i.id AS invoice_id, i.kind, i.paid_at, s.id AS subscription_id, s.status
FROM subscription_invoices i JOIN subscriptions s ON s.id::text = i.subscription_id
WHERE i.status = 'PAID' AND i.kind IN ('INITIAL','REACTIVATION')
  AND s.status = 'PENDING_PAYMENT' AND i.paid_at < now() - interval '15 minutes';

-- 4. platform-revenue payments an earlier settlement run already claimed (never auto-corrected)
SELECT p.purpose, p.settlement_status, count(*) AS payments, sum(p.amount) AS amount
FROM payments p
WHERE p.purpose IN ('ADDON','BILLING_UPGRADE') AND p.settlement_status <> 'UNSETTLED'
GROUP BY 1, 2;

-- 5. …and the settlements that contain them, and whether they were paid out
SELECT s.id, s.status, s.gross_amount, s.net_amount, count(*) AS platform_revenue_items
FROM settlement_items si
JOIN payments p ON p.id = si.payment_id
JOIN settlements s ON s.id = si.settlement_id
WHERE p.purpose IN ('ADDON','BILLING_UPGRADE')
GROUP BY s.id, s.status, s.gross_amount, s.net_amount ORDER BY 1;

-- 6. the reconciliation queue
SELECT kind, status, count(*) FROM payment_reconciliation_exceptions GROUP BY 1,2 ORDER BY 1,2;

-- 7. what to look at, newest first
SELECT kind, provider_object_id, tenant_id, occurrences, last_seen_at, details
FROM payment_reconciliation_exceptions WHERE status = 'OPEN' ORDER BY last_seen_at DESC LIMIT 50;

-- 8. refunds still waiting (PENDING for a while = webhook lost AND the reaper cannot learn the outcome)
SELECT r.id, r."paymentId", r.amount, r.gateway_refund_id, r.created_at
FROM refunds r WHERE r.status = 'PENDING' AND r.created_at < now() - interval '2 hours';

-- 9. Tap payments still on provisional fees after a week
SELECT id, "tenantId", purpose, paid_at FROM payments
WHERE gateway = 'tap' AND status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')
  AND fees_reconciled_at IS NULL AND paid_at < now() - interval '7 days';

-- 10. webhook deliveries by outcome, last 24 h (rejected > 0 deserves a look)
SELECT source, status, event_type, count(*)
FROM webhook_logs WHERE source = 'tap' AND created_at > now() - interval '24 hours'
GROUP BY 1,2,3 ORDER BY 4 DESC;

-- 11. clinics waiting on a first payment for more than 2 days (abandoned checkouts)
SELECT s.id AS subscription_id, s."tenantId", s.created_at, i.id AS invoice_id, i.amount, i.checkout_attempts
FROM subscriptions s
JOIN subscription_invoices i ON i.subscription_id = s.id::text AND i.status = 'OPEN'
WHERE s.status = 'PENDING_PAYMENT' AND s.created_at < now() - interval '2 days';

-- 12. legacy OPEN invoices from before the cut-over (kind IS NULL) — decide per row whether to void
SELECT id, tenant_id, subscription_id, amount, currency, period_start, period_end, issued_at
FROM subscription_invoices WHERE status = 'OPEN' AND kind IS NULL ORDER BY issued_at;
```

**Re-drive an exhausted `payments.outcome`** (safe to repeat — every consumer is idempotent; the new `dedupe_key` is what makes the relay publish it again):

```sql
INSERT INTO outbox_jobs (queue, job_name, dedupe_key, payload, opts)
VALUES ('payments', 'payments.outcome',
        'payment-outcome-paid-<paymentId>-redrive-1',
        '{"tenantId":"<tenantId>","paymentId":"<paymentId>","outcome":"paid"}',
        '{"attempts":12,"backoff":{"type":"exponential","delay":5000}}');
```

## 9. What a green run does not prove

| Not yet proven | Proven by |
|---|---|
| Tap's `hashstring` formula on a real delivery; the webhook response Tap expects; its retry interval | §5 step 6 (or Phase 7 step 2) |
| What Tap appends to `redirect.url`; fees, `net_amount`, payout ids on a real capture; a refunded charge's status | §5 step 6, then the next 03:00 reconcile |
| Saved-card fields (`card.id` vs `payment_agreement`), `1109`, mada merchant-initiated charges | §5 step 8 |
| The merchant id Tap echoes for a clinic; whether our platform key can read a clinic's charges/payouts/refunds | §5 step 9 |
| Payout window and netting behaviour | the first live payouts |

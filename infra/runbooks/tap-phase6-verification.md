# Tap external verification (financial audit, Phase 6)

Everything here needs a real Tap account, a real card, a public webhook URL or an
operator with production access. None of it can be proved by the e2e suites (they use a
fake Tap). Each row is **PASS only with evidence attached** (charge id, screenshot,
log line, CSV row). Never paste secret keys into the evidence.

Tools already in the repo: `scripts/tap-sandbox/{probe,pay,webhook-capture}.js`
(see its README), `node dist/src/tap-preflight.js`.

## A. Subscriptions (ZiyaraTech's own Tap account)

| # | Step | Expected | Evidence |
|---|---|---|---|
| A1 | Production config: `NODE_ENV=production`, `PAYMENT_PROVIDER=tap`, `TAP_ENV=live`, `TAP_MERCHANT_ID`, `TAP_WEBHOOK_URL` set | preflight green: `node dist/src/tap-preflight.js --expect-active --expect-env=live --probe-webhook` | preflight output |
| A2 | Real webhook: `webhook-capture.js` through a tunnel (sandbox) | every delivery reports `hashstring` matched | capture log |
| A3 | Live 1 SAR checkout on a throwaway clinic | webhook arrives, INITIAL invoice PAID, subscription ACTIVE, one `payments.outcome`-free path (no exception rows) | invoice id, charge id |
| A4 | Refund that invoice from the platform admin | Tap refund id, invoice refunded, no exception row | refund id |
| A5 | Next day: `providerReconcile` | the charge appears in the CSV with fee/net, `fees_reconciled_at` set, zero open `payment_reconciliation_exceptions` | CSV row, exceptions count |
| A6 | Production read-only anomaly queries (Phase 0) | zero rows, or a list for manual refund | query outputs |
| A7 | Save Card / MIT (only if `TAP_RECURRING_ENABLED` is wanted) | Tap enables it (probe `B8` no longer `1108`); non-3DS and mada tested | probe output |

## B. Tap Platform (patient payments) - blocked on Tap activation

Prerequisite: Tap's written activation, `TAP_PLATFORM_ID`, and written answers to:
1. Is a platform commission collected on a charge, and how (this decides D-1; until answered `platform_fee` stays 0)?
2. Does the platform key have access to a sub-merchant's reports, refunds and charge list (FIN-P6)?
3. What does Tap post for a dispute / chargeback (FIN-P3 is unbuilt until this is known)?
4. Who bears Tap's fee on a refund (decides the open refund-fee question)?
5. In what form does a charge echo the sub-merchant id (decide `TAP_STRICT_MERCHANT_ECHO`)?

| # | Step | Expected |
|---|---|---|
| B1 | Clinic Lead -> Connect -> APPROVED | `provider_recipient_id` stored |
| B2 | Sandbox charge on the clinic's merchant (`pay.js`) | webhook + return + sweep all end PAID once; `merchant` echo recorded |
| B3 | With `TAP_STRICT_MERCHANT_ECHO=true`, repeat B2 | still PAID (otherwise keep the flag off and record the echo form) |
| B4 | Refund with the platform key | Tap refund id; payment PARTIALLY_REFUNDED/REFUNDED only after Tap confirms |
| B5 | Sub-merchant report + payout | CSV rows with payout_id; settlement mirrored with `source=PROVIDER` |
| B6 | Unpaid booking: leave a PENDING_PAYMENT booking | cancelled after `UNPAID_BOOKING_TTL_MINUTES` (15); a payment confirmed afterwards appears as a `paid_on_cancelled_booking` exception, booking stays cancelled |
| B7 | One live clinic end to end | booking -> pay -> confirm -> cancel (no automatic refund) -> payout matches CSV |

Only after B1-B7: `TAP_BOOKING_PAYMENTS_ENABLED=true` for one clinic, then widen.

## C. Deployment checks for the Phase 1-5 changes

- `SELECT count(*) FROM appointments WHERE status = 'PENDING_PAYMENT'` before deploy: the
  first sweep cancels every one older than the TTL in all tenants and sends notices. Set
  `UNPAID_BOOKING_TTL_MINUTES=0` for the first deploy if any exist.
- Run the four offender queries in the header of migration
  `1730127000000-FinancialIntegrityChecks.ts` on production (read-only). The migration
  refuses to run, changing nothing, if any returns a row.
- A clinic whose `tenant_settings.currency` is KWD/BHD/OMR/JOD can book but cannot pay
  online (currency was removed from the allow-list).

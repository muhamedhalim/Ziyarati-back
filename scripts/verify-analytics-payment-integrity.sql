-- ===========================================================================
-- Analytics accuracy audit (2026-10-21) — PAYMENT DATA THAT ANALYTICS CANNOT
-- COUNT CLEANLY.
--
-- STRICTLY READ-ONLY. SELECTs only: no DDL, no DML, no locks beyond ordinary
-- reads. Safe to run against a live production database at any time.
--
--   psql "$DATABASE_URL" -f scripts/verify-analytics-payment-integrity.sql
--
-- WHY THIS EXISTS: revenue on /app/analytics is "net collected" —
-- PAID / PARTIALLY_REFUNDED payments counted at GREATEST(amount -
-- refunded_amount, 0). That is only right when `refunded_amount` agrees with
-- the refund ledger and with the payment's status. Today's code refuses
-- over-refunds (refund.service, refund-completion.service,
-- refund-webhook.service), but rows written before those guards, by seeds or
-- by hand can still disagree. Each check below lists such rows; an empty
-- result is a pass. Nothing here fixes anything — a fix to financial data is
-- a separate, reviewed decision.
-- ===========================================================================

\echo '1) refunded_amount greater than amount (analytics counts these as 0, never negative)'
SELECT p.id, p."tenantId", p.status, p.amount, p.refunded_amount, p.created_at
  FROM payments p
 WHERE p.refunded_amount > p.amount
 ORDER BY p.created_at;

\echo '2) PARTIALLY_REFUNDED with nothing refunded (counted at full amount)'
SELECT p.id, p."tenantId", p.amount, p.refunded_amount, p.created_at
  FROM payments p
 WHERE p.status = 'PARTIALLY_REFUNDED' AND p.refunded_amount <= 0
 ORDER BY p.created_at;

\echo '3) REFUNDED but refunded_amount below amount (counted as 0 by status, money may remain)'
SELECT p.id, p."tenantId", p.amount, p.refunded_amount, p.created_at
  FROM payments p
 WHERE p.status = 'REFUNDED' AND p.refunded_amount < p.amount
 ORDER BY p.created_at;

\echo '4) refunded_amount does not match the SUCCEEDED refund ledger'
SELECT p.id, p."tenantId", p.status, p.refunded_amount,
       COALESCE(r.ledger, 0) AS ledger_sum
  FROM payments p
  LEFT JOIN (
        SELECT "paymentId", SUM(amount) AS ledger
          FROM refunds
         WHERE status = 'SUCCEEDED'
         GROUP BY "paymentId"
       ) r ON r."paymentId" = p.id
 WHERE p.refunded_amount <> COALESCE(r.ledger, 0)
 ORDER BY p.created_at;

\echo '5) collected payments with no paid_at (analytics dates them by created_at)'
SELECT p.id, p."tenantId", p.status, p.amount, p.created_at
  FROM payments p
 WHERE p.status IN ('PAID', 'PARTIALLY_REFUNDED') AND p.paid_at IS NULL
 ORDER BY p.created_at;

\echo '6) collected clinic revenue with no branch and no booking (shown as "not linked to a branch")'
SELECT p."tenantId", COUNT(*) AS payments, SUM(GREATEST(p.amount - p.refunded_amount, 0)) AS net
  FROM payments p
 WHERE p.status IN ('PAID', 'PARTIALLY_REFUNDED')
   AND p.purpose IN ('BOOKING', 'MANUAL')
   AND p."branchId" IS NULL
   AND p."appointmentId" IS NULL
 GROUP BY p."tenantId"
 ORDER BY net DESC;

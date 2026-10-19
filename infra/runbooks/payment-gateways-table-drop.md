# Retiring the `payment_gateways` table (DEFERRED)

**Status: migration written and tested locally (scratch clone + e2e DB). NOT run in production or in the dev DB.**

The `/platform/payment-gateways` page, its `/payment-gateways` API, `PaymentGatewayService`, the `PaymentGateway`
entity and the two audit-action constants were removed from the code. The table itself is deliberately left in place
and the migration refuses to drop it unless it is empty, because the content of the PRODUCTION table has not been verified.

## Why this was safe to remove from code
- Provider selection is `PAYMENT_PROVIDER` (`PaymentGatewayFactory.resolve`), never this table.
- Nothing read the table except the removed service. No worker, job, webhook, view, trigger or function references it.
- Dev (`ziyarati`) and e2e (`ziyarati_e2e`) databases: 0 rows; the only constraint is the outgoing FK `payment_gateways.tenantId -> tenants`;
  no inbound FK, no view, no trigger, no function body mentions it, one index (the primary key).
- The `payments`, `subscription_invoices`, merchant tables and all Tap configuration are untouched.

## Step 1 — read-only preflight on PRODUCTION (operator, via the approved DB access path)
```sql
SELECT count(*) AS rows, count(*) FILTER (WHERE config IS NOT NULL) AS rows_with_config FROM payment_gateways;
SELECT gateway_name, is_active, "tenantId" IS NOT NULL AS has_tenant, created_at FROM payment_gateways ORDER BY created_at;
-- dependencies (expect zero rows each)
SELECT conname, conrelid::regclass FROM pg_constraint WHERE confrelid = 'payment_gateways'::regclass;
SELECT c.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class c ON c.oid = r.ev_class
 WHERE d.refobjid = 'payment_gateways'::regclass AND c.relkind IN ('v','m');
SELECT proname FROM pg_proc WHERE prosrc ILIKE '%payment_gateways%';
-- historic audit trail (kept; rows are plain strings in audit_logs)
SELECT count(*) FROM audit_logs WHERE action LIKE 'platform_admin.payment_gateway.%';
```
Do **not** inspect `config` values in a shared channel: it was documented as non-secret, but an operator could have pasted a key into it.

## Step 2 — the migration (written, NOT run in production)
`src/migrations/1730122000000-DropPaymentGateways.ts` (+ spec). It runs in the migration's own transaction and:
1. does nothing if the table is already gone;
2. takes `LOCK TABLE ... ACCESS EXCLUSIVE` first, so no insert can slip in between the check and the drop;
3. **fails (rolls back, drops nothing)** if the table holds any row or anything references it (foreign key / view);
4. otherwise drops the outgoing FK and the table (no `CASCADE`).

`down()` recreates the empty table and its FK exactly as the baseline defined them (verified identical with `d`). Dropped rows cannot be restored; there are none by construction.
Impact: milliseconds of ACCESS EXCLUSIVE lock on an empty table. If production has rows, the deploy's migrate step FAILS by design: export/review them (Step 1), then decide.
Verified on a throwaway clone and on `ziyarati_e2e` (up, up again, down, up), plus: row present → refused, dependent FK → refused, concurrent uncommitted insert → waits, then refused.

## Left in place on purpose
- `src/migrations/1700000000000-BaselineSchema.ts` (history; a fresh database still creates the table until Step 2 ships).
- Historic `audit_logs` rows with `platform_admin.payment_gateway.*` actions and the support-timeline test that asserts that string stays hidden.

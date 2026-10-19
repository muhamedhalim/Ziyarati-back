# Retiring the `payment_gateways` table (DEFERRED)

**Status: NOT executed anywhere. The table still exists in every database that was migrated before this change.**

The `/platform/payment-gateways` page, its `/payment-gateways` API, `PaymentGatewayService`, the `PaymentGateway`
entity and the two audit-action constants were removed from the code. The table itself is deliberately left in place
because the content of the PRODUCTION table has not been verified.

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

## Step 2 — only if rows = 0 (or the operator has approved discarding the rows)
Add this as a new top-level file in `src/migrations/` (e.g. `1730122000000-DropPaymentGateways.ts`; the runner globs only that folder).
It refuses to drop a non-empty table, so it cannot destroy data even if run unreviewed.

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropPaymentGateways1730122000000 implements MigrationInterface {
  name = 'DropPaymentGateways1730122000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF to_regclass('public.payment_gateways') IS NOT NULL
           AND EXISTS (SELECT 1 FROM "payment_gateways") THEN
          RAISE EXCEPTION 'payment_gateways is not empty; export and review its rows before dropping it';
        END IF;
      END $$;
    `);
    // Order: dependent constraint first, then the table (its PK index goes with it).
    await q.query(`ALTER TABLE IF EXISTS "payment_gateways" DROP CONSTRAINT IF EXISTS "FK_0290b49027c109e05d84ed6e693"`);
    await q.query(`DROP TABLE IF EXISTS "payment_gateways"`);
  }

  /** Recreates the empty structure only (as the baseline migration defined it). Dropped rows are not restorable. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS "payment_gateways" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "gateway_name" character varying NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "config" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "tenantId" uuid, CONSTRAINT "PK_2b022a3aafb792a1afe3e14e06f" PRIMARY KEY ("id"))`);
    await q.query(`ALTER TABLE "payment_gateways" ADD CONSTRAINT "FK_0290b49027c109e05d84ed6e693" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
  }
}
```

Impact: metadata-only DDL on an (expected) empty table, takes an ACCESS EXCLUSIVE lock for milliseconds.
Rollback: `down` recreates the empty table; rows cannot be restored, so export them in Step 1 if there are any.
Then also: regenerate `docs/schema/schema.sql` (git-ignored) if you keep it current.

## Left in place on purpose
- `src/migrations/1700000000000-BaselineSchema.ts` (history; a fresh database still creates the table until Step 2 ships).
- Historic `audit_logs` rows with `platform_admin.payment_gateway.*` actions and the support-timeline test that asserts that string stays hidden.

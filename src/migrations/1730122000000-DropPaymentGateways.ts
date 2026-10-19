import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires `payment_gateways`.
 *
 * The table backed the removed `/platform/payment-gateways` screen only. Nothing
 * selects a payment provider from it (that is `PAYMENT_PROVIDER`), and nothing in
 * the schema depends on it: its single foreign key points OUT to `tenants`.
 *
 * Safety:
 *  - Runs inside the migration's own transaction. The table is locked
 *    ACCESS EXCLUSIVE *before* it is inspected, so no row can be inserted between
 *    the emptiness check and the drop (the check and the drop are atomic).
 *  - REFUSES to drop a table that holds any row, or that anything else references
 *    (a foreign key, a view). The migration then fails and the transaction rolls
 *    back: nothing is lost, and the rows must be reviewed and exported by an
 *    operator first. It never deletes data.
 *  - Idempotent: a database where the table is already gone is left untouched.
 *
 * Rollback: `down()` recreates the EMPTY table exactly as the baseline defined it.
 * Rows cannot come back (there are none by construction).
 *
 * `BaselineSchema` is left as the historical record: on a fresh database it still
 * creates the table, and this migration then drops it.
 */
export class DropPaymentGateways1730122000000 implements MigrationInterface {
  name = 'DropPaymentGateways1730122000000';

  public async up(q: QueryRunner): Promise<void> {
    const [{ exists }] = (await q.query(
      `SELECT to_regclass('public.payment_gateways') IS NOT NULL AS "exists"`,
    )) as Array<{ exists: boolean }>;
    if (!exists) return;

    // Blocks concurrent writers until this transaction ends.
    await q.query(`LOCK TABLE "payment_gateways" IN ACCESS EXCLUSIVE MODE`);

    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM "payment_gateways"`,
    )) as Array<{ n: number }>;
    if (n > 0) {
      throw new Error(
        `Refusing to drop "payment_gateways": it holds ${n} row(s). Review and export them first; this migration never deletes data.`,
      );
    }

    const [{ refs }] = (await q.query(
      `SELECT (
         (SELECT count(*) FROM pg_constraint
           WHERE confrelid = 'public.payment_gateways'::regclass)
         +
         (SELECT count(*) FROM pg_depend d
            JOIN pg_rewrite r ON r.oid = d.objid
            JOIN pg_class c ON c.oid = r.ev_class
           WHERE d.refobjid = 'public.payment_gateways'::regclass
             AND c.relkind IN ('v', 'm'))
       )::int AS refs`,
    )) as Array<{ refs: number }>;
    if (refs > 0) {
      throw new Error(
        `Refusing to drop "payment_gateways": ${refs} foreign key(s)/view(s) depend on it.`,
      );
    }

    // No CASCADE: if anything unexpected still depends on it, Postgres refuses.
    await q.query(
      `ALTER TABLE "payment_gateways" DROP CONSTRAINT IF EXISTS "FK_0290b49027c109e05d84ed6e693"`,
    );
    await q.query(`DROP TABLE "payment_gateways"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS "payment_gateways" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "gateway_name" character varying NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "config" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "tenantId" uuid, CONSTRAINT "PK_2b022a3aafb792a1afe3e14e06f" PRIMARY KEY ("id"))`,
    );
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'FK_0290b49027c109e05d84ed6e693'
             AND conrelid = 'public.payment_gateways'::regclass
        ) THEN
          ALTER TABLE "payment_gateways"
            ADD CONSTRAINT "FK_0290b49027c109e05d84ed6e693"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }
}

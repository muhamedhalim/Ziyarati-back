import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase-3A financial-safety schema:
 *  - R1: `settlement_adjustments` (clawback ledger)
 *  - R5: append-only enforcement on `transactions` (block UPDATE/DELETE)
 * Idempotent; mirrors PaymentsSchemaBootstrap. Rollback-safe.
 */
export class PaymentsPhase3a1730000300000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS settlement_adjustments (
        id                     uuid PRIMARY KEY,
        tenant_id              uuid NOT NULL,
        payment_id             uuid NOT NULL,
        refund_id              uuid,
        origin_settlement_id   uuid,
        applied_settlement_id  uuid,
        amount_cents           bigint NOT NULL,
        reason                 text,
        status                 varchar(20) NOT NULL DEFAULT 'OPEN',
        created_at             timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_settlement_adj_open
      ON settlement_adjustments (tenant_id, status) WHERE status = 'OPEN'
    `);
    await q.query(`
      CREATE OR REPLACE FUNCTION trg_transactions_immutable() RETURNS trigger AS $func$
      BEGIN
        RAISE EXCEPTION 'transactions is append-only: % is not permitted', TG_OP;
      END;
      $func$ LANGUAGE plpgsql
    `);
    await q.query(`DROP TRIGGER IF EXISTS transactions_no_mutate ON transactions`);
    await q.query(`
      CREATE TRIGGER transactions_no_mutate
      BEFORE UPDATE OR DELETE ON transactions
      FOR EACH ROW EXECUTE FUNCTION trg_transactions_immutable()
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS transactions_no_mutate ON transactions`);
    await q.query(`DROP FUNCTION IF EXISTS trg_transactions_immutable()`);
    await q.query(`DROP TABLE IF EXISTS settlement_adjustments`);
  }
}

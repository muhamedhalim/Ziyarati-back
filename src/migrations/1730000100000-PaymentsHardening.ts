import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase-1 payments hardening schema (migrations-first / synchronize=false).
 * Mirrors PaymentsSchemaBootstrap exactly; idempotent.
 */
export class PaymentsHardening1730000100000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS tenant_counters (
        tenant_id uuid NOT NULL,
        name      text NOT NULL,
        seq       bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, name)
      )
    `);
    await q.query(`ALTER TABLE refunds ADD COLUMN IF NOT EXISTS idempotency_key varchar`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_idem
      ON refunds ("tenantId", idempotency_key) WHERE idempotency_key IS NOT NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_refund_payment_status
      ON refunds ("paymentId", status)
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_webhook_event
      ON transactions (gateway_transaction_id)
      WHERE type = 'webhook' AND gateway_transaction_id IS NOT NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_txn_payment
      ON transactions ("paymentId", created_at)
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_settlement_claim
      ON payments ("tenantId", status, settlement_status, paid_at)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_payments_settlement_claim`);
    await q.query(`DROP INDEX IF EXISTS idx_txn_payment`);
    await q.query(`DROP INDEX IF EXISTS uq_txn_webhook_event`);
    await q.query(`DROP INDEX IF EXISTS idx_refund_payment_status`);
    await q.query(`DROP INDEX IF EXISTS uq_refund_idem`);
    await q.query(`ALTER TABLE refunds DROP COLUMN IF EXISTS idempotency_key`);
    await q.query(`DROP TABLE IF EXISTS tenant_counters`);
  }
}

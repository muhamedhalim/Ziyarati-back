import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase-2 ledger / webhook-refund-reconciliation schema (H2). Idempotent;
 * mirrors the additions in PaymentsSchemaBootstrap.
 */
export class PaymentsLedger1730000200000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE refunds ADD COLUMN IF NOT EXISTS gateway_refund_id varchar`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_gateway_id
      ON refunds (gateway_refund_id) WHERE gateway_refund_id IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS uq_refund_gateway_id`);
    await q.query(`ALTER TABLE refunds DROP COLUMN IF EXISTS gateway_refund_id`);
  }
}

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Idempotently ensures the Phase-1 payments-hardening schema objects exist:
 *  - `tenant_counters` (atomic per-tenant invoice numbering — H1)
 *  - UNIQUE (tenant, idempotency_key) on refunds (safe refund retries — C1)
 *  - partial UNIQUE on transactions(gateway_transaction_id) for webhook events
 *    (race-proof dedup — H4)
 *  - supporting indexes for refund aggregation and the settlement claim
 *
 * Why a bootstrap: this repo runs `synchronize=true` in dev (so the configured
 * migration does NOT run there). These statements are all `IF NOT EXISTS`, so
 * they are safe to run on every boot and in every environment; the canonical
 * migration mirrors them for migrations-first prod. Fails SOFT per statement so
 * a permissions hiccup never blocks startup.
 *
 * FK column names follow TypeORM's default naming in this project
 * (`"tenantId"`, `"paymentId"`, `"branchId"`); the settlement claim resolves
 * these from metadata at runtime, so a mismatch here only costs an index.
 */
@Injectable()
export class PaymentsSchemaBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('PaymentsSchemaBootstrap');

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run('tenant_counters table', `
      CREATE TABLE IF NOT EXISTS tenant_counters (
        tenant_id uuid NOT NULL,
        name      text NOT NULL,
        seq       bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, name)
      )
    `);

    // Defensive: the column is also mapped on the Refund entity (synchronize
    // creates it in dev); ADD … IF NOT EXISTS makes this safe everywhere.
    await this.run('refunds.idempotency_key column', `
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS idempotency_key varchar
    `);

    await this.run('refund idempotency unique', `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_idem
      ON refunds ("tenantId", idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    await this.run('refund aggregation index', `
      CREATE INDEX IF NOT EXISTS idx_refund_payment_status
      ON refunds ("paymentId", status)
    `);

    // Phase 2 (H2): webhook refund reconciliation idempotency.
    await this.run('refunds.gateway_refund_id column', `
      ALTER TABLE refunds ADD COLUMN IF NOT EXISTS gateway_refund_id varchar
    `);
    await this.run('refund gateway-id unique', `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_gateway_id
      ON refunds (gateway_refund_id)
      WHERE gateway_refund_id IS NOT NULL
    `);

    await this.run('webhook dedup unique', `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_webhook_event
      ON transactions (gateway_transaction_id)
      WHERE type = 'webhook' AND gateway_transaction_id IS NOT NULL
    `);

    await this.run('transaction payment index', `
      CREATE INDEX IF NOT EXISTS idx_txn_payment
      ON transactions ("paymentId", created_at)
    `);

    await this.run('settlement claim index', `
      CREATE INDEX IF NOT EXISTS idx_payments_settlement_claim
      ON payments ("tenantId", status, settlement_status, paid_at)
    `);

    // R1: clawback / settlement-adjustment ledger. A refund landing on an
    // already-claimed/settled payment records an OPEN adjustment here; the next
    // settlement run claims (OPEN → APPLIED) and nets it out — keeping total
    // settled = collected − refunded − fees regardless of refund timing.
    await this.run('settlement_adjustments table', `
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
    await this.run('settlement_adjustments open index', `
      CREATE INDEX IF NOT EXISTS idx_settlement_adj_open
      ON settlement_adjustments (tenant_id, status) WHERE status = 'OPEN'
    `);

    // R5: transactions are an immutable audit log — block UPDATE/DELETE at the
    // DB layer (the app only ever INSERTs). Idempotent (CREATE OR REPLACE + drop).
    await this.run('transactions immutability function', `
      CREATE OR REPLACE FUNCTION trg_transactions_immutable() RETURNS trigger AS $func$
      BEGIN
        RAISE EXCEPTION 'transactions is append-only: % is not permitted', TG_OP;
      END;
      $func$ LANGUAGE plpgsql
    `);
    await this.run('transactions immutability trigger (drop)', `
      DROP TRIGGER IF EXISTS transactions_no_mutate ON transactions
    `);
    await this.run('transactions immutability trigger (create)', `
      CREATE TRIGGER transactions_no_mutate
      BEFORE UPDATE OR DELETE ON transactions
      FOR EACH ROW EXECUTE FUNCTION trg_transactions_immutable()
    `);
  }

  private async run(label: string, sql: string): Promise<void> {
    try {
      await this.dataSource.query(sql);
    } catch (err) {
      this.logger.warn(`Skipped "${label}": ${(err as Error).message}`);
    }
  }
}

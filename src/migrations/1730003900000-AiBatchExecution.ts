import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Batch execution mode + Data Residency scaffolding.
 *
 * Additive and revertable. Introduces the batch-job / batch-item tables, the
 * per-tenant data-residency deployment table, and extends the cost ledger to
 * differentiate STANDARD vs BATCH spend and the region/deployment used.
 */
export class AiBatchExecution1730003900000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ── Batch jobs ──────────────────────────────────────────────────────────
    await q.query(`CREATE TABLE IF NOT EXISTS ai_batch_jobs (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      feature varchar(80) NOT NULL,
      execution_mode varchar(20) NOT NULL DEFAULT 'BATCH',
      provider varchar(40) NOT NULL DEFAULT 'openai',
      endpoint varchar(60) NOT NULL,
      model varchar(100) NOT NULL,
      status varchar(30) NOT NULL DEFAULT 'PREPARING',
      idempotency_key varchar(200) NOT NULL,
      /** Opaque correlation id echoed into the remote batch metadata; lets the
          reconciler find a batch created during a crash window (no external id saved). */
      correlation_id varchar(80),
      external_batch_id varchar(120),
      input_file_id varchar(120),
      output_file_id varchar(120),
      error_file_id varchar(120),
      /** Poll scheduling: next_poll_at gates the sweep; poll_attempts drives backoff. */
      next_poll_at timestamptz,
      poll_attempts integer NOT NULL DEFAULT 0,
      last_error varchar(200),
      total_requests integer NOT NULL DEFAULT 0,
      completed_requests integer NOT NULL DEFAULT 0,
      failed_requests integer NOT NULL DEFAULT 0,
      input_tokens bigint NOT NULL DEFAULT 0,
      output_tokens bigint NOT NULL DEFAULT 0,
      embedding_tokens bigint NOT NULL DEFAULT 0,
      cost_microusd bigint,
      pricing_status varchar(20) NOT NULL DEFAULT 'UNPRICED',
      error_code varchar(80),
      region varchar(40),
      deployment_id uuid,
      agent_id uuid,
      source_type varchar(40),
      source_id varchar(120),
      metadata jsonb,
      submitted_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_ai_batch_job_idempotency UNIQUE (tenant_id, idempotency_key))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_tenant ON ai_batch_jobs (tenant_id)`);
    // Partial index over non-terminal jobs, ordered by next_poll_at — the sweep's
    // lease query scans only these and picks the ones due for a poll.
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_active ON ai_batch_jobs (next_poll_at, status)
      WHERE status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED')`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_source ON ai_batch_jobs (tenant_id, source_type, source_id)
      WHERE source_id IS NOT NULL`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_correlation ON ai_batch_jobs (correlation_id)
      WHERE correlation_id IS NOT NULL`);

    // ── Batch items (per-request lines, bound by custom_id) ─────────────────
    await q.query(`CREATE TABLE IF NOT EXISTS ai_batch_items (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      batch_job_id uuid NOT NULL REFERENCES ai_batch_jobs(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      /** Opaque UUID — carries NO tenant/file/patient data; bound internally below. */
      custom_id varchar(64) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'PENDING',
      source_type varchar(40),
      source_id varchar(120),
      /** Position of the chunk within its source (for the internal binding constraint). */
      chunk_index integer,
      target_ref varchar(120),
      input_tokens integer NOT NULL DEFAULT 0,
      error_code varchar(120),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_ai_batch_item_custom_id UNIQUE (batch_job_id, custom_id))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_batch_items_job ON ai_batch_items (batch_job_id, status)`);
    // Internal binding: at most one item per (job, source, chunk) — makes a
    // duplicate/replayed chunk mapping impossible independent of custom_id.
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_batch_item_source_chunk
      ON ai_batch_items (batch_job_id, source_type, source_id, chunk_index)
      WHERE source_id IS NOT NULL AND chunk_index IS NOT NULL`);

    // ── Data residency (per-tenant regional deployment) ─────────────────────
    await q.query(`CREATE TABLE IF NOT EXISTS tenant_ai_deployments (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      enabled boolean NOT NULL DEFAULT false,
      provider varchar(40) NOT NULL DEFAULT 'openai',
      region varchar(40),
      base_url text,
      openai_project varchar(120),
      api_key_ciphertext text,
      allowed_regions text[],
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_tenant_ai_deployment_tenant UNIQUE (tenant_id))`);

    // ── Cost ledger: differentiate STANDARD vs BATCH + region/deployment ────
    await q.query(`ALTER TABLE ai_cost_entries ADD COLUMN IF NOT EXISTS execution_mode varchar(20) NOT NULL DEFAULT 'STANDARD'`);
    await q.query(`ALTER TABLE ai_cost_entries ADD COLUMN IF NOT EXISTS region varchar(40)`);
    await q.query(`ALTER TABLE ai_cost_entries ADD COLUMN IF NOT EXISTS batch_job_id uuid`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_cost_mode ON ai_cost_entries (tenant_id, execution_mode, created_at)`);

    // Monthly aggregate: separate batch embedding tokens + batch cost so the
    // dashboard can show standard vs batch spend without re-scanning entries.
    await q.query(`ALTER TABLE ai_cost_logs ADD COLUMN IF NOT EXISTS batch_embedding_tokens bigint NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_cost_logs ADD COLUMN IF NOT EXISTS batch_cost_microusd bigint NOT NULL DEFAULT 0`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE ai_cost_logs DROP COLUMN IF EXISTS batch_cost_microusd`);
    await q.query(`ALTER TABLE ai_cost_logs DROP COLUMN IF EXISTS batch_embedding_tokens`);
    await q.query(`DROP INDEX IF EXISTS idx_ai_cost_mode`);
    await q.query(`ALTER TABLE ai_cost_entries DROP COLUMN IF EXISTS batch_job_id`);
    await q.query(`ALTER TABLE ai_cost_entries DROP COLUMN IF EXISTS region`);
    await q.query(`ALTER TABLE ai_cost_entries DROP COLUMN IF EXISTS execution_mode`);
    await q.query(`DROP TABLE IF EXISTS tenant_ai_deployments`);
    await q.query(`DROP TABLE IF EXISTS ai_batch_items`);
    await q.query(`DROP TABLE IF EXISTS ai_batch_jobs`);
  }
}

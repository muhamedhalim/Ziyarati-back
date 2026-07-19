import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive AI cost, deduplication, idempotency, and indexing state schema. */
export class AiFinopsHardening1730003800000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE ai_cost_logs ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_cost_logs ADD COLUMN IF NOT EXISTS embedding_tokens integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_cost_logs ADD COLUMN IF NOT EXISTS cost_microusd bigint NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_cost_logs ADD COLUMN IF NOT EXISTS unpriced_requests integer NOT NULL DEFAULT 0`);

    await q.query(`ALTER TABLE ai_knowledge_bases ADD COLUMN IF NOT EXISTS content_hash varchar(64)`);
    await q.query(`ALTER TABLE ai_knowledge_bases ADD COLUMN IF NOT EXISTS embedding_version varchar(80) NOT NULL DEFAULT 'legacy-v1'`);
    await q.query(`UPDATE ai_knowledge_bases SET content_hash=md5(id::text || ':legacy-v1') || md5('legacy:' || id::text) WHERE content_hash IS NULL`);
    await q.query(`ALTER TABLE ai_knowledge_bases ALTER COLUMN content_hash SET NOT NULL`);
    await q.query(`DROP INDEX IF EXISTS uq_ai_kb_content_hash`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_kb_source_content_hash ON ai_knowledge_bases ("tenantId", "agentId", COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid), content_hash)`);

    await q.query(`ALTER TABLE ai_training_files ADD COLUMN IF NOT EXISTS error_code varchar(60)`);
    await q.query(`ALTER TABLE ai_training_files ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_training_files ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_training_files ADD COLUMN IF NOT EXISTS content_hash varchar(64)`);
    await q.query(`ALTER TABLE ai_training_files ADD COLUMN IF NOT EXISTS processing_started_at timestamptz`);
    await q.query(`ALTER TABLE ai_training_files ADD COLUMN IF NOT EXISTS indexed_at timestamptz`);
    // Previous INDEXED rows never passed a physical pipeline and must be made honest.
    await q.query(`UPDATE ai_training_files SET status='PENDING', error_code=NULL WHERE status IN ('UPLOADED','INDEXED')`);

    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS feature varchar(80) NOT NULL DEFAULT 'chat'`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS route varchar(160) NOT NULL DEFAULT 'ai.chat'`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS idempotency_key varchar(120)`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS embedding_tokens integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_execution_metrics ALTER COLUMN cost_usd DROP NOT NULL`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS cost_microusd bigint`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS pricing_status varchar(20) NOT NULL DEFAULT 'UNPRICED'`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS tool_loop_count integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS provider_attempts integer NOT NULL DEFAULT 1`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS provider_retry_count integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS cached_request_count integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE ai_execution_metrics ADD COLUMN IF NOT EXISTS truncated_prompt_tokens integer NOT NULL DEFAULT 0`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_metrics_attribution ON ai_execution_metrics ("tenantId", feature, channel, created_at)`);

    await q.query(`CREATE TABLE IF NOT EXISTS ai_cost_entries (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id uuid NOT NULL REFERENCES tenants(id),
      ai_conversation_id uuid, idempotency_key varchar(180) NOT NULL, request_kind varchar(20) NOT NULL,
      provider varchar(40) NOT NULL, model varchar(100) NOT NULL, feature varchar(80) NOT NULL,
      route varchar(160) NOT NULL, channel varchar(30) NOT NULL, input_tokens integer NOT NULL DEFAULT 0,
      cached_input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
      embedding_tokens integer NOT NULL DEFAULT 0, tool_loop_index integer NOT NULL DEFAULT 0,
      provider_attempts integer NOT NULL DEFAULT 1, cache_hit boolean NOT NULL DEFAULT false,
      cached_request_count integer NOT NULL DEFAULT 0, success boolean NOT NULL,
      error_code varchar(80), pricing_status varchar(20) NOT NULL, price_catalog_version varchar(80),
      price_source text, price_effective_at date, input_price_microusd_per_million bigint,
      cached_input_price_microusd_per_million bigint, output_price_microusd_per_million bigint,
      embedding_price_microusd_per_million bigint, cost_microusd bigint, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_ai_cost_entry_idempotency UNIQUE (tenant_id,idempotency_key))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_cost_attribution ON ai_cost_entries (tenant_id,feature,channel,created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_cost_conversation ON ai_cost_entries (tenant_id,ai_conversation_id,created_at) WHERE ai_conversation_id IS NOT NULL`);

    await q.query(`CREATE TABLE IF NOT EXISTS ai_request_executions (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id uuid NOT NULL REFERENCES tenants(id),
      idempotency_key varchar(180) NOT NULL, feature varchar(80) NOT NULL, channel varchar(30) NOT NULL,
      state varchar(30) NOT NULL, error_code varchar(80), response_json jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_ai_request_execution UNIQUE (tenant_id,idempotency_key))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS ai_request_executions`);
    await q.query(`DROP TABLE IF EXISTS ai_cost_entries`);
    await q.query(`DROP INDEX IF EXISTS uq_ai_kb_source_content_hash`);
  }
}

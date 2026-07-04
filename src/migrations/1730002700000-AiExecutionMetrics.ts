import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Advanced AI Monitoring: one row per completed AI turn, capturing latency
 * (total / first-token / RAG / embedding / tool), token + cost accounting, and
 * tool success/failure counts. Feeds both the tenant-scoped AiMetricsService
 * and the cross-tenant platform AiMonitoringService — additive, idempotent.
 */
export class AiExecutionMetrics1730002700000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "ai_execution_metrics" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid,
        "ai_conversation_id" uuid,
        "channel" character varying(20) NOT NULL,
        "model" character varying(60) NOT NULL,
        "streamed" boolean NOT NULL DEFAULT false,
        "fallback" boolean NOT NULL DEFAULT false,
        "success" boolean NOT NULL DEFAULT true,
        "error_message" text,
        "prompt_tokens" integer NOT NULL DEFAULT 0,
        "completion_tokens" integer NOT NULL DEFAULT 0,
        "total_tokens" integer NOT NULL DEFAULT 0,
        "cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
        "rag_retrieval_ms" integer,
        "embedding_ms" integer,
        "tool_calls_count" integer NOT NULL DEFAULT 0,
        "tool_success_count" integer NOT NULL DEFAULT 0,
        "tool_failure_count" integer NOT NULL DEFAULT 0,
        "tool_exec_ms" integer NOT NULL DEFAULT 0,
        "first_token_ms" integer,
        "streaming_duration_ms" integer,
        "total_latency_ms" integer NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_execution_metrics" PRIMARY KEY ("id")
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_aiexec_tenant" ON "ai_execution_metrics" ("tenantId")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_aiexec_created" ON "ai_execution_metrics" ("created_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_aiexec_model" ON "ai_execution_metrics" ("model")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_aiexec_channel" ON "ai_execution_metrics" ("channel")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_aiexec_conv" ON "ai_execution_metrics" ("ai_conversation_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "ai_execution_metrics"`);
  }
}

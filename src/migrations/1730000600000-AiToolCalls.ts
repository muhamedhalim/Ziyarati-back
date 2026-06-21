import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ai_tool_calls` — audit + idempotency ledger for AI-executed business actions
 * (mirrors AiToolCallsBootstrap). Idempotent (IF NOT EXISTS).
 */
export class AiToolCalls1730000600000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS ai_tool_calls (
        id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id          uuid NOT NULL,
        ai_conversation_id varchar,
        conversation_id    uuid,
        tool_name          varchar(50) NOT NULL,
        arguments          jsonb,
        status             varchar(20) NOT NULL DEFAULT 'PENDING',
        result             jsonb,
        error              text,
        appointment_id     uuid,
        idempotency_key    varchar NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        completed_at       timestamptz
      )
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_tool_call_idem ON ai_tool_calls (tenant_id, idempotency_key)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_conv ON ai_tool_calls (tenant_id, ai_conversation_id, created_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS ai_tool_calls`);
  }
}

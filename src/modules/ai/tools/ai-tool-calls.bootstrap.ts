import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Idempotently ensures the `ai_tool_calls` table — the audit + idempotency ledger
 * for AI-executed business actions (availability checks, booking, reschedule,
 * cancel). Created as a raw table (not a frozen `src/entities` entity), matching
 * this repo's convention for new non-entity tables (tenant_counters,
 * settlement_adjustments, ai_kb_embeddings); accessed via raw SQL in the
 * dispatcher. Dev runs synchronize (which would ignore this table); the
 * `1730000600000-AiToolCalls.ts` migration mirrors it for migrations-first prod.
 *
 *  - `uq_ai_tool_call_idem (tenant_id, idempotency_key)` → prevents a retried /
 *    repeated booking from executing twice (the dispatcher claims via
 *    INSERT … ON CONFLICT DO NOTHING and replays the prior result).
 *  - `status` PENDING → SUCCEEDED / FAILED captures failed attempts too.
 *  - `appointment_id` links the action to the resulting appointment.
 */
@Injectable()
export class AiToolCallsBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('AiToolCallsBootstrap');

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await this.run(runner, 'ai_tool_calls table', `
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
      await this.run(runner, 'ai_tool_calls idempotency unique', `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_tool_call_idem
        ON ai_tool_calls (tenant_id, idempotency_key)
      `);
      await this.run(runner, 'ai_tool_calls conversation index', `
        CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_conv
        ON ai_tool_calls (tenant_id, ai_conversation_id, created_at)
      `);
    } finally {
      await runner.release();
    }
  }

  private async run(runner: { query(sql: string): Promise<unknown> }, label: string, sql: string): Promise<void> {
    try {
      await runner.query(sql);
    } catch (err) {
      this.logger.warn(`Skipped "${label}": ${(err as Error).message}`);
    }
  }
}

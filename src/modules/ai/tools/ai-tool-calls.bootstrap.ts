import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SchemaGuardRegistry } from '../../../config/schema-guard.registry';

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
 *
 * Two record kinds share this table, distinguished by `idempotency_key` (AI-008,
 * FR-023, FR-029a-e — see `AiToolDispatchService`'s "Idempotent execution +
 * audit ledger" section for the write paths):
 *  - CLAIM rows — a real business-action write (booking, reschedule, cancel,
 *    admin tool). Key participates in `uq_ai_tool_call_idem`. Lifetime is
 *    UNBOUNDED — never purged by retention, regardless of age.
 *  - ATTEMPT rows — a permission denial/refusal or a session-state tool call
 *    (public-booking selection steps). Key is namespaced `attempt:<tool>:<uuid>`,
 *    by construction never equal to a claim key, and is terminal on insert
 *    (never replayed). Lifetime is BOUNDED: `AiToolCallRetentionService`
 *    (`ai-tool-call-retention.service.ts`) purges these once older than
 *    `AI_TOOL_CALL_RETENTION_DAYS` (default 90 days), via the daily
 *    `ai.toolCallRetention` sweep registered in `ScheduleRegistrarService`
 *    (04:30 UTC). An incident responder querying this table should assume
 *    ATTEMPT rows older than the configured window are gone; CLAIM rows are
 *    not subject to any window.
 */
@Injectable()
export class AiToolCallsBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly dataSource: DataSource,
    private readonly guards: SchemaGuardRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await this.run(
        runner,
        'ai_tool_calls table',
        `
        CREATE TABLE IF NOT EXISTS ai_tool_calls (
          id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id           uuid NOT NULL,
          ai_conversation_id  varchar,
          conversation_id     uuid,
          tool_name           varchar(50) NOT NULL,
          arguments           jsonb,
          status              varchar(20) NOT NULL DEFAULT 'PENDING',
          result              jsonb,
          error               text,
          appointment_id      uuid,
          idempotency_key     varchar NOT NULL,
          created_at          timestamptz NOT NULL DEFAULT now(),
          completed_at        timestamptz,
          correlation_id      varchar,
          actor_user_id       uuid,
          resource_tenant_id  uuid
        )
      `,
      );
      await this.run(
        runner,
        'ai_tool_calls idempotency unique',
        `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_tool_call_idem
        ON ai_tool_calls (tenant_id, idempotency_key)
      `,
      );
      await this.run(
        runner,
        'ai_tool_calls conversation index',
        `
        CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_conv
        ON ai_tool_calls (tenant_id, ai_conversation_id, created_at)
      `,
      );
      // M1 (AI-008, AI-016, AI-017, AI-024) — parity with
      // 1730041000000-AiToolCallAuditColumns.ts (FR-107). `CREATE TABLE IF
      // NOT EXISTS` above only fires on a fresh database, so an
      // already-bootstrapped dev table needs these explicit ALTERs too;
      // both paths converge on the same shape, both idempotent.
      await this.run(
        runner,
        'ai_tool_calls M1 correlation_id column',
        `ALTER TABLE ai_tool_calls ADD COLUMN IF NOT EXISTS correlation_id varchar`,
      );
      await this.run(
        runner,
        'ai_tool_calls M1 actor_user_id column',
        `ALTER TABLE ai_tool_calls ADD COLUMN IF NOT EXISTS actor_user_id uuid`,
      );
      await this.run(
        runner,
        'ai_tool_calls M1 resource_tenant_id column',
        `ALTER TABLE ai_tool_calls ADD COLUMN IF NOT EXISTS resource_tenant_id uuid`,
      );
      // Plain (non-CONCURRENTLY) here, matching this bootstrap's existing
      // two indexes — a dev table is small, so a brief write-blocking lock
      // is immaterial; the migration's CONCURRENTLY build is what protects
      // a real, hot production table.
      await this.run(
        runner,
        'ai_tool_calls M1 correlation index',
        `
        CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_correlation
        ON ai_tool_calls (correlation_id) WHERE correlation_id IS NOT NULL
      `,
      );
      await this.run(
        runner,
        'ai_tool_calls M1 actor index',
        `
        CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_actor
        ON ai_tool_calls (tenant_id, actor_user_id, created_at) WHERE actor_user_id IS NOT NULL
      `,
      );
      await this.run(
        runner,
        'ai_tool_calls M1 resource_tenant index',
        `
        CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_resource_tenant
        ON ai_tool_calls (resource_tenant_id) WHERE resource_tenant_id IS NOT NULL
      `,
      );
      await this.run(
        runner,
        'ai_tool_calls M1 retention index',
        `
        CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_retention
        ON ai_tool_calls (created_at) WHERE status IN ('DENIED', 'REFUSED')
      `,
      );
    } finally {
      await runner.release();
    }
  }

  /**
   * A DB-enforced integrity guard. Failure is an ERROR and degrades readiness
   * (`SchemaGuardRegistry`) — never a `warn` that scrolls past.
   */
  private async require(
    runner: { query(sql: string): Promise<unknown> },
    label: string,
    sql: string,
  ): Promise<void> {
    await this.guards.ensure({
      owner: 'AiToolCallsBootstrap',
      label,
      criticality: 'required',
      run: () => runner.query(sql),
    });
  }

  /** A performance index. Losing one costs latency, not correctness. */
  private async run(
    runner: { query(sql: string): Promise<unknown> },
    label: string,
    sql: string,
  ): Promise<void> {
    await this.guards.ensure({
      owner: 'AiToolCallsBootstrap',
      label,
      criticality: 'optional',
      run: () => runner.query(sql),
    });
  }
}

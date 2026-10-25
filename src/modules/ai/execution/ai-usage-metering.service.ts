import { DataSource, EntityManager } from 'typeorm';

import { AiMessage } from '../../../entities/AI Agent/AiMessage';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { UsageService } from '../../subscription-billing/usage.service';
import { USAGE_METRIC } from '../../subscription-billing/usage-metric';
import { AI_MESSAGE_ROLE, currentPeriodMonth } from '../ai.constants';

/** Which allowance paid for the turn's 1-token admission (see `UsageService`). */
export type AiQuotaFundedBy = 'plan' | 'credit' | 'none';

/**
 * The write side of an AI turn that `sendMessage` and `streamMessage` share:
 * the final assistant row, the monthly usage-log upsert and the token-quota
 * settlement.
 *
 * WHY IT EXISTS. These steps were written out twice, once per pipeline, so a
 * metering fix had to be made in both or the two transports drifted apart
 * (the failure mode the 2026-08 generic-error fix already hit). They now live
 * in one place; `ai-execution.send-stream-parity.spec.ts` pins that the two
 * paths leave the same footprint.
 *
 * A plain class, not a Nest provider: `AiExecutionService` builds it from the
 * `DataSource` and `UsageService` it already has, so its positional
 * constructor — and every spec that builds it — is unchanged.
 */
export class AiUsageMeteringService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly usage: UsageService,
  ) {}

  /**
   * Persist the final assistant message and meter the turn's usage in ONE short
   * transaction (never held across a provider or tool call).
   */
  persistAssistantTurn(p: {
    tenantId: string;
    meterTenantId: string;
    aiConversationId: string;
    agentId: string | null;
    content: string;
    completionTokens: number;
    totalTokens: number;
  }): Promise<AiMessage> {
    return this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(AiMessage).save(
        manager.getRepository(AiMessage).create({
          ai_conversation_id: p.aiConversationId,
          tenant: { id: p.tenantId } as Tenant,
          role: AI_MESSAGE_ROLE.ASSISTANT,
          content: p.content,
          tokens_used: p.completionTokens,
        }),
      );
      await this.recordUsage(
        manager,
        p.meterTenantId,
        p.agentId,
        p.totalTokens,
      );
      return saved;
    });
  }

  /**
   * Top the turn's 1-token admission reservation up to its real size.
   *
   * 1 was already reserved atomically by the pre-check — add only the
   * remainder so the total recorded equals `totalTokens` (a no-op via
   * `increment()`'s own guard if `totalTokens` is somehow <= 1).
   */
  async settleTokens(
    tenantId: string,
    totalTokens: number,
    fundedBy: AiQuotaFundedBy,
  ): Promise<void> {
    await this.usage.increment(
      tenantId,
      USAGE_METRIC.AI_TOKENS,
      totalTokens - 1,
    );
    if (fundedBy === 'credit') {
      // FIN-011: the credit-funded turn pays its real cost, not 1 unit.
      await this.usage
        .settleCreditRemainder(tenantId, USAGE_METRIC.AI_TOKENS, totalTokens - 1)
        .catch(() => undefined);
    }
  }

  /**
   * Atomically increment the monthly usage row for (tenant, agent).
   *
   * Was find-then-save, which lost updates under concurrent turns (two turns read
   * the same row → last write wins → tokens undercounted) or hit 23505. A single
   * `INSERT … ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x` against the existing
   * UNIQUE(tenantId, agentId, period_month) is race-safe — the running total can
   * never be lost. Runs inside the caller's transaction.
   *
   * AGENT-OPTIONAL. Callers used to skip this entirely when a turn had no agent
   * (`if (agent) recordUsage(...)`), so every guest/public turn and every turn
   * on a tenant with no Admin-provisioned agent went UNRECORDED. `agentId` is
   * nullable on the table, so those turns are now recorded with a NULL agent.
   *
   * The NULL case needs its own upsert: Postgres treats NULLs as DISTINCT in a
   * unique index, so `ON CONFLICT ("tenantId","agentId",period_month)` can never
   * match a NULL-agent row and would insert a fresh row per turn. It is done as
   * UPDATE-then-INSERT instead. Two concurrent first-turns of a period can both
   * miss the UPDATE and insert, leaving two rows for that period — no tokens are
   * lost (every reader aggregates with `SUM(...)`, and `topAgents` filters
   * `agent IS NOT NULL`), it is only an extra row. Removing even that would take
   * a partial unique index on (tenantId, period_month) WHERE agentId IS NULL,
   * which is schema surface this fix does not need.
   */
  async recordUsage(
    manager: EntityManager,
    tenantId: string,
    agentId: string | null,
    tokens: number,
  ): Promise<void> {
    const period = currentPeriodMonth();

    if (agentId === null) {
      const result: unknown = await manager.query(
        `UPDATE ai_usage_logs
            SET total_tokens   = total_tokens   + $3,
                total_requests = total_requests + 1
          WHERE "tenantId" = $1 AND "agentId" IS NULL AND period_month = $2
        RETURNING id`,
        [tenantId, period, tokens],
      );
      // TypeORM's Postgres driver answers an UPDATE … RETURNING with a TUPLE,
      // `[rows, affectedCount]`, not the bare row array a SELECT gives. This used
      // to read `.length` of the tuple — always 2 — so it took "the row exists"
      // as a fact and returned, and the INSERT below never ran: no agent-less turn
      // (every guest turn, every clinic without an agent) was ever written to
      // `ai_usage_logs`, so the clinic's AI usage analytics for them stayed empty.
      const touched =
        Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
      if (Array.isArray(touched) && touched.length > 0) return;

      await manager.query(
        `INSERT INTO ai_usage_logs ("tenantId", "agentId", period_month, total_tokens, total_requests)
         VALUES ($1, NULL, $2, $3, 1)`,
        [tenantId, period, tokens],
      );
      return;
    }

    await manager.query(
      `INSERT INTO ai_usage_logs ("tenantId", "agentId", period_month, total_tokens, total_requests)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT ("tenantId", "agentId", period_month)
       DO UPDATE SET total_tokens   = ai_usage_logs.total_tokens   + EXCLUDED.total_tokens,
                     total_requests = ai_usage_logs.total_requests + 1`,
      [tenantId, agentId, period, tokens],
    );
  }
}

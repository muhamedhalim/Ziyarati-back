import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { AppError } from '../../../common/errors';
import type { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  toolActorUserId,
  toolErrorMessage,
  type ToolResult,
} from './ai-tool-args';
import type { ToolContext } from './ai-tool-dispatch.service';

type Executor = () => Promise<{
  toolResult: ToolResult;
  resultJson: unknown;
  appointmentId?: string;
}>;

/**
 * The `ai_tool_calls` ledger: idempotent execution of business-action writes
 * and the audit record of every attempt (DENIED / REFUSED / SUCCEEDED).
 *
 * Extracted verbatim from `AiToolDispatchService` — same SQL, same statuses,
 * same replay and claim semantics. It is a plain class (not a Nest provider) so
 * the dispatcher's constructor, and every place that builds it, is unchanged.
 */
export class AiToolCallLedger {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly logger: Logger,
  ) {}

  /**
   * AI-008/C1 (FR-023): recording that a call was ATTEMPTED and claiming an
   * idempotency key for a business-action WRITE are separable concerns —
   * this is the record step. Used for a `DENIED` or `REFUSED` outcome,
   * which never reaches `run()`'s claim step below (the permission check
   * that produces them runs and returns before `run()` is ever called).
   *
   * Never claims anything — always inserts under the non-claiming
   * `attempt:` key namespace (T066), so it can never pre-claim, block, or
   * collide with a real business-action claim (FR-027). Never replays —
   * every denial is its own fresh attempt, by design (FR-024: "a denial
   * followed by a retry is two attempts and therefore two records").
   * Best-effort: a ledger write failure here degrades to a logged warning
   * and never fails the attempt itself (FR-028, matching the turn-metric
   * record's existing posture).
   */
  async recordAttempt(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    status: 'DENIED' | 'REFUSED',
    reason: string,
  ): Promise<void> {
    await this.writeAttemptRow(ctx, toolName, args, status, reason);
  }

  /**
   * AI-008/C1 (FR-026): the seven public-booking session-state tools
   * (`selectClinic`…`selectSlot`) never call `run()` at all, on success or
   * failure — they record on the SAME `attempt:` terms as a denial, one row
   * per call, regardless of outcome. Deliberately NOT idempotency-claimed
   * (no `PENDING`/`EXECUTING`, no replay) — these are session-state writes,
   * not business-action writes, and MUST NOT acquire semantics they do not
   * need (FR-026): there is no side effect here to dedupe, and a real claim
   * key would misrepresent the record kind.
   */
  async recordSessionAttempt(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      const result = await fn();
      const status = result.success === false ? 'REFUSED' : 'SUCCEEDED';
      const reason =
        result.success === false && typeof result.error === 'string'
          ? result.error
          : null;
      await this.writeAttemptRow(ctx, toolName, args, status, reason);
      return result;
    } catch (err) {
      await this.writeAttemptRow(
        ctx,
        toolName,
        args,
        'REFUSED',
        toolErrorMessage(err, this.logger),
      );
      throw err;
    }
  }

  /** Shared by `recordAttempt` and `recordSessionAttempt` — one INSERT, never a claim. */
  async writeAttemptRow(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    status: 'DENIED' | 'REFUSED' | 'SUCCEEDED',
    reason: string | null,
  ): Promise<void> {
    const key = `attempt:${toolName}:${randomUUID()}`;
    try {
      await this.dataSource.query(
        `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, conversation_id, tool_name, arguments, status, error, idempotency_key, correlation_id, actor_user_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          ctx.tenantId,
          ctx.aiConversationId,
          ctx.conversationId ?? null,
          toolName,
          JSON.stringify(args),
          status,
          reason,
          key,
          // AI-016 (FR-030, FR-032): written as explicit null when none can
          // be established, never omitted, so an operator can tell "not
          // recorded" from "not applicable."
          this.tenantContext.getCorrelationId(),
          toolActorUserId(ctx),
        ],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to record ${status} attempt for ${toolName}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Claim the idempotency key, run `executor`, and record the outcome. Replays a
   * prior SUCCEEDED call and reports in-flight or terminal/unknown outcomes
   * without replaying a potentially completed side effect. The claim step
   * (FR-023) — byte-for-byte unchanged by the record/claim split above.
   */
  async run(
    ctx: ToolContext,
    toolName: string,
    key: string,
    args: Record<string, unknown>,
    executor: Executor,
    /**
     * AI-024 (FR-035, FR-036, C4): the tenant OWNING the resource acted
     * upon, when it differs from `ctx.tenantId` (the conversation tenant —
     * today, only `bookPublicAppointment`'s resolved clinic tenant).
     * Additive: `tenant_id` on the claim row is never repurposed or
     * overwritten — it stays the conversation tenant, byte-identical to
     * before this parameter existed. Omitted (`undefined`) for every other
     * caller, which is exactly "same as tenant_id" (null).
     */
    resourceTenantId?: string,
  ): Promise<ToolResult> {
    const existing = await this.findByKey(ctx.tenantId, key);
    if (existing) {
      if (existing.status === 'SUCCEEDED') {
        return { ...(existing.result as ToolResult), idempotentReplay: true };
      }
      if (existing.status === 'PENDING' || existing.status === 'EXECUTING') {
        return {
          success: false,
          error: 'A matching action is already in progress.',
        };
      }
      // A refusal the application itself recorded (slot taken, outside the
      // booking window ...) is a definite outcome, not an unknown one: hand the
      // model that reason so it offers an alternative, instead of telling the
      // patient a human must verify something that plainly did not happen.
      if (existing.status === 'FAILED_PERMANENT' && existing.error) {
        return { success: false, error: existing.error };
      }
      // Anything else (UNKNOWN_OUTCOME ...) genuinely needs verification.
      return {
        success: false,
        error:
          'This action was already attempted and requires manual verification.',
      };
    }

    // Claim atomically; on a concurrent race the conflicting row already owns it.
    // AI-016/AI-017/AI-024 (FR-030, FR-032, FR-033, FR-034, FR-035, FR-036):
    // correlation_id, actor_user_id, and resource_tenant_id are additive to
    // this claim insert — the ON CONFLICT/idempotency semantics, and
    // tenant_id itself, are unchanged (FR-027, FR-036).
    const claimed = await this.dataSource.query(
      `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, conversation_id, tool_name, arguments, status, idempotency_key, correlation_id, actor_user_id, resource_tenant_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6, $7, $8, $9)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        ctx.tenantId,
        ctx.aiConversationId,
        ctx.conversationId ?? null,
        toolName,
        JSON.stringify(args),
        key,
        this.tenantContext.getCorrelationId(),
        toolActorUserId(ctx),
        // Null means "same as tenant_id" — only set when it genuinely
        // differs (today: bookPublicAppointment's resolved clinic tenant).
        resourceTenantId && resourceTenantId !== ctx.tenantId
          ? resourceTenantId
          : null,
      ],
    );
    const id: string | undefined = claimed[0]?.id;
    if (!id) {
      const raced = await this.findByKey(ctx.tenantId, key);
      if (raced?.status === 'SUCCEEDED')
        return { ...(raced.result as ToolResult), idempotentReplay: true };
      return {
        success: false,
        error: 'A matching action is already in progress.',
      };
    }

    return this.executeAndRecord(id, executor);
  }

  private async executeAndRecord(
    id: string,
    executor: Executor,
  ): Promise<ToolResult> {
    try {
      await this.dataSource.query(
        `UPDATE ai_tool_calls SET status='EXECUTING' WHERE id=$1 AND status='PENDING'`,
        [id],
      );
      const { toolResult, resultJson, appointmentId } = await executor();
      await this.dataSource.query(
        `UPDATE ai_tool_calls
         SET status='SUCCEEDED', result=$2::jsonb, appointment_id=$3, completed_at=now()
         WHERE id=$1`,
        [id, JSON.stringify(resultJson), appointmentId ?? null],
      );
      return toolResult;
    } catch (err) {
      const state =
        err instanceof AppError ? 'FAILED_PERMANENT' : 'UNKNOWN_OUTCOME';
      const message =
        err instanceof AppError
          ? toolErrorMessage(err, this.logger)
          : 'Unknown execution outcome; manual verification is required.';
      await this.dataSource.query(
        `UPDATE ai_tool_calls SET status=$2, error=$3, completed_at=now() WHERE id=$1`,
        [id, state, message],
      );
      this.logger.warn(`tool call ${id} ${state}`);
      // Returned to the model so it can apologize / offer an alternative.
      return { success: false, error: message };
    }
  }

  async findByKey(
    tenantId: string,
    key: string,
  ): Promise<{
    id: string;
    status: string;
    result: unknown;
    error?: string | null;
  } | null> {
    const rows = await this.dataSource.query(
      `SELECT id, status, result, error FROM ai_tool_calls WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, key],
    );
    return rows[0] ?? null;
  }
}

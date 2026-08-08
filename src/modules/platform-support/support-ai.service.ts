import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SupportClinicResolver } from './support-clinic.resolver';
import { QuerySupportDiagnosticsDto } from './dto/query-support-diagnostics.dto';
import { isoOrNull, sanitizeFailureReason } from './support-privacy.util';

/**
 * ============================================================================
 *  AI DIAGNOSTICS — read-only
 * ============================================================================
 *
 * Answers the AI-flavoured support cases: "the assistant stopped booking",
 * "it said it booked but nothing appeared", "the bot never handed over".
 *
 * WHAT IS DELIBERATELY NOT HERE, and why:
 *   - `ai_tool_calls.arguments` / `.result` — these JSONB blobs carry the
 *     patient's name, phone and requested service. Support gets the tool NAME,
 *     its STATUS, and a sanitized error; never the payload.
 *   - `ai_conversations.session` — live session state, including the booking
 *     draft (patient identity again) and auth state.
 *   - `ai_messages` — the conversation transcript. A private conversation
 *     between a clinic's patient and the assistant is not support material.
 *   - Everything on `ai_execution_metrics` touching money: `cost_usd`,
 *     `cost_microusd`, `pricing_status`, and every token counter. Internal
 *     platform AI cost is Super Admin's surface; Support cannot reach it and
 *     nothing here approximates it.
 *   - System prompts, RAG content and knowledge-base material.
 *   - `tenant_ai_deployments.api_key_ciphertext` (see SupportIntegrationService).
 *
 * READ-ONLY, and specifically NO RE-EXECUTION. There is no method here that
 * re-runs a tool call. Re-running `book_appointment`, `cancel_appointment`,
 * `reschedule_appointment` or any payment action would be a transactional
 * business write performed by a support agent on a clinic's behalf — out of
 * scope until a separately-reviewed permission exists for it.
 */
@Injectable()
export class SupportAiService {
  constructor(
    private readonly clinics: SupportClinicResolver,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Headline AI health for the clinic plus the recent tool-call ledger — the
   * two things a ticket about "the assistant isn't working" actually needs.
   */
  async diagnostics(tenantId: string, query: QuerySupportDiagnosticsDto) {
    await this.clinics.assertExists(tenantId);

    const [toolCalls, conversations, handovers] = await Promise.all([
      this.toolCalls(tenantId, query),
      this.conversationSummary(tenantId, query),
      this.handoverSummary(tenantId, query),
    ]);

    return {
      toolCalls,
      conversations,
      handovers,
      windowDays: query.days,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * The `ai_tool_calls` ledger — the audit trail for AI-executed business
   * actions. `appointment_id` is included because it is the single most useful
   * correlation a support agent can make: "the tool said SUCCEEDED, here is
   * the appointment it created, go look at its diagnostics".
   */
  private async toolCalls(tenantId: string, query: QuerySupportDiagnosticsDto) {
    const params = [tenantId, query.since()];
    const where = `tenant_id = $1 AND created_at >= $2`;

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM ai_tool_calls WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT id, tool_name, status, error, appointment_id,
               ai_conversation_id, conversation_id, created_at, completed_at
          FROM ai_tool_calls
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    return {
      data: rows.map((r: ToolCallRow) => ({
        id: r.id,
        toolName: r.tool_name,
        status: r.status,
        succeeded: r.status === 'SUCCEEDED',
        /** Sanitized — tool errors quote provider responses and identifiers. */
        failureReason: sanitizeFailureReason(r.error),
        /** Correlation handle into the appointment diagnostics. */
        appointmentId: r.appointment_id ?? null,
        aiConversationId: r.ai_conversation_id ?? null,
        conversationId: r.conversation_id ?? null,
        createdAt: isoOrNull(r.created_at),
        completedAt: isoOrNull(r.completed_at),
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Conversation activity by channel and state. Counts and timestamps only —
   * no transcript, no session state, no participant identity.
   */
  private async conversationSummary(tenantId: string, query: QuerySupportDiagnosticsDto) {
    const rows = await this.dataSource.query(
      `
      SELECT channel,
             status,
             COUNT(*)::int  AS count,
             MAX(created_at) AS last_activity_at
        FROM ai_conversations
       WHERE "tenantId" = $1 AND created_at >= $2
       GROUP BY channel, status
       ORDER BY channel ASC, status ASC
      `,
      [tenantId, query.since()],
    );

    return rows.map((r: ConversationSummaryRow) => ({
      /** WEBSITE | WHATSAPP | DASHBOARD | API — where the session came from. */
      channel: r.channel,
      status: r.status,
      count: Number(r.count),
      lastActivityAt: isoOrNull(r.last_activity_at),
    }));
  }

  /**
   * Human-handover state. `reason` and `notes` are free text written by staff
   * and by the assistant about a live patient conversation, so neither is
   * selected — only whether a handover was requested, its state and its
   * timing, which is what "the bot never escalated to us" turns on.
   */
  private async handoverSummary(tenantId: string, query: QuerySupportDiagnosticsDto) {
    const [row] = await this.dataSource.query(
      `
      SELECT COUNT(*)::int                                       AS total,
             COUNT(*) FILTER (WHERE status = 'PENDING')::int     AS pending,
             COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
             MAX(created_at)                                     AS last_requested_at,
             MAX(resolved_at)                                    AS last_resolved_at
        FROM handover_requests
       WHERE "tenantId" = $1 AND created_at >= $2
      `,
      [tenantId, query.since()],
    );

    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      resolved: Number(row?.resolved ?? 0),
      lastRequestedAt: isoOrNull(row?.last_requested_at),
      lastResolvedAt: isoOrNull(row?.last_resolved_at),
    };
  }
}

interface ToolCallRow {
  id: string;
  tool_name: string;
  status: string;
  error: string | null;
  appointment_id: string | null;
  ai_conversation_id: string | null;
  conversation_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

interface ConversationSummaryRow {
  channel: string;
  status: string;
  count: number;
  last_activity_at: Date | null;
}

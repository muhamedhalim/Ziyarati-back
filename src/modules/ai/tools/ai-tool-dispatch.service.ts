import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError } from '../../../common/errors';
import { AppointmentSource } from '../../../entities/enums';
import { AppointmentsService } from '../../appointment/appointment.service';
import { PublicDiscoveryService } from '../../public-discovery/public-discovery.service';
import { AvailabilityService } from '../../scheduling/availability.service';
import { AiToolCall } from '../providers/ai-provider.interface';
import { AI_TOOL } from './ai-tools.constants';

/** Context for a tool execution, all bound server-side (never from the model). */
export interface ToolContext {
  tenantId: string;
  /** Authenticated user driving the AI turn — the booking actor (booked_by). */
  actorUserId?: string;
  aiConversationId: string;
  /** Optional linked human conversation (for audit). */
  conversationId?: string;
}

/** The structured result handed back to the model as the `tool` message. */
type ToolResult = Record<string, unknown>;

/**
 * Executes the model's tool calls against the EXISTING domain services — the
 * model never writes to appointment tables.
 *
 * Safety properties:
 *  - Tenant is bound from context, never from tool arguments; every referenced
 *    resource is re-validated for tenant ownership inside the reused services.
 *  - Booking/reschedule/cancel go through AppointmentsService, which runs the
 *    transactional `assertBookable` race-safe double-booking check — no booking
 *    logic is duplicated here.
 *  - Every write tool is idempotent: a deterministic idempotency key + the
 *    `uq_ai_tool_call_idem` unique index means a retried or repeated booking
 *    executes at most once; a prior SUCCEEDED call replays its result.
 *  - Every call (success or failure) is recorded in `ai_tool_calls` for audit.
 */
@Injectable()
export class AiToolDispatchService {
  private readonly logger = new Logger('AiToolDispatchService');

  constructor(
    private readonly appointments: AppointmentsService,
    private readonly availability: AvailabilityService,
    private readonly discovery: PublicDiscoveryService,
    private readonly dataSource: DataSource,
  ) {}

  /** Parse + route one tool call. Never throws — returns a result for the model. */
  async execute(ctx: ToolContext, call: AiToolCall): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { success: false, error: 'Invalid tool arguments (not valid JSON).' };
    }

    try {
      switch (call.name) {
        case AI_TOOL.SEARCH_CLINICS:
          return await this.searchClinics(ctx, args);
        case AI_TOOL.GET_CLINIC_DETAILS:
          return await this.getClinicDetails(ctx, args);
        case AI_TOOL.SEARCH_PUBLIC_AVAILABILITY:
          return await this.searchPublicAvailability(ctx, args);
        case AI_TOOL.CHECK_AVAILABILITY:
          return await this.checkAvailability(ctx, args);
        case AI_TOOL.BOOK_APPOINTMENT:
          return await this.bookAppointment(ctx, args);
        case AI_TOOL.RESCHEDULE_APPOINTMENT:
          return await this.rescheduleAppointment(ctx, args);
        case AI_TOOL.CANCEL_APPOINTMENT:
          return await this.cancelAppointment(ctx, args);
        default:
          return { success: false, error: `Unknown tool "${call.name}".` };
      }
    } catch (err) {
      // Defensive: business errors are handled per-tool; this catches the rest.
      return { success: false, error: this.msg(err) };
    }
  }

  // ───────────────────────── Public discovery tools ──────────────────────── //

  /** Cross-tenant public clinic search — read-only, safe for anonymous chats. */
  private async searchClinics(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.str(args.query);
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    return this.run(ctx, AI_TOOL.SEARCH_CLINICS, `search_clinics:${randomUUID()}`, args, async () => {
      const clinics = await this.discovery.searchClinics(query, limit);
      return {
        toolResult: { success: true, count: clinics.length, clinics },
        resultJson: { count: clinics.length },
      };
    });
  }

  /** Branches, doctors and services (with prices) for a chosen clinic. */
  private async getClinicDetails(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const clinicId = this.str(args.clinicId);
    if (!clinicId) return { success: false, error: 'clinicId is required.' };
    return this.run(ctx, AI_TOOL.GET_CLINIC_DETAILS, `clinic_details:${randomUUID()}`, args, async () => {
      const detail = await this.discovery.clinicDetail(clinicId);
      return { toolResult: { success: true, ...detail }, resultJson: { clinicId } };
    });
  }

  /** Free slots for a publicly-discovered clinic's branch + doctor on a day. */
  private async searchPublicAvailability(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const branchId = this.str(args.branchId);
    const staffId = this.str(args.staffId);
    const date = this.str(args.date);
    if (!branchId || !staffId || !date) {
      return { success: false, error: 'branchId, staffId and date are required.' };
    }
    return this.run(ctx, AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, `pub_avail:${randomUUID()}`, args, async () => {
      const result = await this.discovery.publicAvailability(
        branchId,
        staffId,
        date,
        typeof args.slotMinutes === 'number' ? args.slotMinutes : undefined,
      );
      return { toolResult: { success: true, ...result }, resultJson: result };
    });
  }

  // ─────────────────────────────── Tools ─────────────────────────────────── //

  /** Read-only — no idempotency dedup, but still audited. */
  private async checkAvailability(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const branchId = this.str(args.branchId);
    const staffId = this.str(args.staffId);
    const date = this.str(args.date);
    if (!branchId || !staffId || !date) {
      return { success: false, error: 'branchId, staffId and date are required.' };
    }
    return this.run(ctx, AI_TOOL.CHECK_AVAILABILITY, `check:${randomUUID()}`, args, async () => {
      const result = await this.availability.windows(ctx.tenantId, {
        branchId,
        staffId,
        date,
        slotMinutes: typeof args.slotMinutes === 'number' ? args.slotMinutes : undefined,
      } as never);
      return { toolResult: { success: true, ...result }, resultJson: result };
    });
  }

  private async bookAppointment(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!ctx.actorUserId) {
      return { success: false, error: 'Booking is not available in this context (no acting user).' };
    }
    const branchId = this.str(args.branchId);
    const customerId = this.str(args.customerId);
    const staffId = this.str(args.staffId);
    const startAt = this.str(args.startAt);
    if (!branchId || !customerId || !staffId || !startAt) {
      return { success: false, error: 'branchId, customerId, staffId and startAt are required.' };
    }
    const serviceIds = Array.isArray(args.serviceIds)
      ? args.serviceIds.filter((s): s is string => typeof s === 'string')
      : undefined;

    // Deterministic key: the same (conversation, staff, start) booking intent can
    // execute at most once, even across retried turns.
    const key = `book:${ctx.aiConversationId}:${staffId}:${startAt}`;

    return this.run(ctx, AI_TOOL.BOOK_APPOINTMENT, key, args, async () => {
      const appt = await this.appointments.create(ctx.tenantId, ctx.actorUserId!, {
        branchId,
        customerId,
        staffId,
        startAt,
        serviceIds,
        notes: this.str(args.notes),
        source: AppointmentSource.WHATSAPP_BOT,
      });
      return {
        appointmentId: appt.id,
        resultJson: { appointmentId: appt.id, status: appt.status, startAt: appt.start_at, endAt: appt.end_at },
        toolResult: {
          success: true,
          appointmentId: appt.id,
          status: appt.status,
          startAt: appt.start_at,
          endAt: appt.end_at,
        },
      };
    });
  }

  private async rescheduleAppointment(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!ctx.actorUserId) {
      return { success: false, error: 'Reschedule is not available in this context (no acting user).' };
    }
    const appointmentId = this.str(args.appointmentId);
    const newStartAt = this.str(args.newStartAt);
    if (!appointmentId || !newStartAt) {
      return { success: false, error: 'appointmentId and newStartAt are required.' };
    }
    const key = `reschedule:${appointmentId}:${newStartAt}`;

    return this.run(ctx, AI_TOOL.RESCHEDULE_APPOINTMENT, key, args, async () => {
      const appt = await this.appointments.reschedule(ctx.tenantId, ctx.actorUserId!, appointmentId, {
        newStartAt,
        reason: this.str(args.reason),
      });
      return {
        appointmentId: appt.id,
        resultJson: { appointmentId: appt.id, startAt: appt.start_at, endAt: appt.end_at },
        toolResult: { success: true, appointmentId: appt.id, startAt: appt.start_at, endAt: appt.end_at },
      };
    });
  }

  private async cancelAppointment(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!ctx.actorUserId) {
      return { success: false, error: 'Cancellation is not available in this context (no acting user).' };
    }
    const appointmentId = this.str(args.appointmentId);
    if (!appointmentId) {
      return { success: false, error: 'appointmentId is required.' };
    }
    const key = `cancel:${appointmentId}`;

    return this.run(ctx, AI_TOOL.CANCEL_APPOINTMENT, key, args, async () => {
      const appt = await this.appointments.cancel(ctx.tenantId, ctx.actorUserId!, appointmentId, {
        reason: this.str(args.reason),
      });
      return {
        appointmentId: appt.id,
        resultJson: { appointmentId: appt.id, status: appt.status },
        toolResult: { success: true, appointmentId: appt.id, status: appt.status },
      };
    });
  }

  // ───────────────── Idempotent execution + audit ledger ──────────────────── //

  /**
   * Claim the idempotency key, run `executor`, and record the outcome. Replays a
   * prior SUCCEEDED call, reports an in-flight PENDING, and retries a FAILED one.
   */
  private async run(
    ctx: ToolContext,
    toolName: string,
    key: string,
    args: Record<string, unknown>,
    executor: () => Promise<{ toolResult: ToolResult; resultJson: unknown; appointmentId?: string }>,
  ): Promise<ToolResult> {
    const existing = await this.findByKey(ctx.tenantId, key);
    if (existing) {
      if (existing.status === 'SUCCEEDED') {
        return { ...(existing.result as ToolResult), idempotentReplay: true };
      }
      if (existing.status === 'PENDING') {
        return { success: false, error: 'A matching action is already in progress.' };
      }
      // FAILED → allow a retry by reopening the same ledger row.
      await this.dataSource.query(
        `UPDATE ai_tool_calls SET status='PENDING', error=NULL, completed_at=NULL WHERE id=$1`,
        [existing.id],
      );
      return this.executeAndRecord(existing.id, executor);
    }

    // Claim atomically; on a concurrent race the conflicting row already owns it.
    const claimed = await this.dataSource.query(
      `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, conversation_id, tool_name, arguments, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [ctx.tenantId, ctx.aiConversationId, ctx.conversationId ?? null, toolName, JSON.stringify(args), key],
    );
    const id: string | undefined = claimed[0]?.id;
    if (!id) {
      const raced = await this.findByKey(ctx.tenantId, key);
      if (raced?.status === 'SUCCEEDED') return { ...(raced.result as ToolResult), idempotentReplay: true };
      return { success: false, error: 'A matching action is already in progress.' };
    }

    return this.executeAndRecord(id, executor);
  }

  private async executeAndRecord(
    id: string,
    executor: () => Promise<{ toolResult: ToolResult; resultJson: unknown; appointmentId?: string }>,
  ): Promise<ToolResult> {
    try {
      const { toolResult, resultJson, appointmentId } = await executor();
      await this.dataSource.query(
        `UPDATE ai_tool_calls
         SET status='SUCCEEDED', result=$2::jsonb, appointment_id=$3, completed_at=now()
         WHERE id=$1`,
        [id, JSON.stringify(resultJson), appointmentId ?? null],
      );
      return toolResult;
    } catch (err) {
      const message = this.msg(err);
      await this.dataSource.query(
        `UPDATE ai_tool_calls SET status='FAILED', error=$2, completed_at=now() WHERE id=$1`,
        [id, message],
      );
      this.logger.warn(`tool call ${id} FAILED: ${message}`);
      // Returned to the model so it can apologize / offer an alternative.
      return { success: false, error: message };
    }
  }

  private async findByKey(
    tenantId: string,
    key: string,
  ): Promise<{ id: string; status: string; result: unknown } | null> {
    const rows = await this.dataSource.query(
      `SELECT id, status, result FROM ai_tool_calls WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, key],
    );
    return rows[0] ?? null;
  }

  // ──────────────────────────── small helpers ────────────────────────────── //

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v : undefined;
  }

  private msg(err: unknown): string {
    if (err instanceof AppError) return err.message;
    return err instanceof Error ? err.message : 'Tool execution failed.';
  }
}

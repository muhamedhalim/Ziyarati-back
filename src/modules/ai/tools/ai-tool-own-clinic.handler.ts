import { randomUUID } from 'node:crypto';
import { safeZone } from '../../scheduling/timezone.util';
import { describeToday } from '../prompt/turn-clock';
import { AI_CHANNEL } from '../../ai-orchestrator/ai-channel.constants';
import { AI_TOOL } from './ai-tools.constants';
import { type ToolResult } from './ai-tool-args';
import { PublicBookingContextService } from '../../public-booking/public-booking-context.service';
import { SESSION_UNSET } from '../../ai-orchestrator/conversation-session.service';
import { AiToolHandlerBase } from './ai-tool-handler.base';
import type { ToolContext } from './ai-tool-dispatch.service';

// Moved verbatim out of `AiToolDispatchService` (Phase 4 / S-01). Behaviour is unchanged.
/**
 * How many services / doctors the WhatsApp ESTABLISHED BOOKING CONTEXT lists. The
 * block shares `AI_PROMPT_BOOKING_CONTEXT_TOKENS` (500) and is truncated from the
 * END; a clinic with more than this is pointed at the list tools for the rest.
 */
const WHATSAPP_CONTEXT_MAX_SERVICES = 8;
const WHATSAPP_CONTEXT_MAX_DOCTORS = 6;

export class OwnClinicToolHandler extends AiToolHandlerBase {
  /**
   * Passes `result` through untouched; on a SUCCESSFUL WhatsApp call records the
   * branch / doctor it used. `args` are the model's, so each id is shape-checked
   * before it is written and re-proved against the tenant before it is ever shown.
   */
  async remembered(
    ctx: ToolContext,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (
      ctx.channel === AI_CHANNEL.WHATSAPP &&
      !this.isGuest(ctx) &&
      result.success !== false
    ) {
      await this.rememberOwnClinicSelection(ctx, {
        branchId: this.uuid(args.branchId),
        staffId: this.uuid(args.staffId),
      });
    }
    return result;
  }

  /** Best effort: a failed note must never fail the tool call that produced it. */
  async rememberOwnClinicSelection(
    ctx: ToolContext,
    ids: { branchId?: string; staffId?: string },
  ): Promise<void> {
    if (!ids.branchId && !ids.staffId) return;
    try {
      const prior = await this.sessions.get(ctx.tenantId, ctx.aiConversationId);
      const patch: Parameters<
        PublicBookingContextService['patchSelection']
      >[2] = {};
      if (ids.branchId && ids.branchId !== prior.selectedBranchId) {
        patch.selectedBranchId = ids.branchId;
        // A doctor belongs to one branch's roster: moving to another branch
        // drops the previous doctor unless this same call names one.
        patch.selectedDoctorId = SESSION_UNSET;
      }
      if (ids.staffId && ids.staffId !== prior.selectedDoctorId) {
        patch.selectedDoctorId = ids.staffId;
      }
      if (Object.keys(patch).length === 0) return;
      await this.bookingContext.patchSelection(
        ctx.tenantId,
        ctx.aiConversationId,
        patch,
      );
    } catch (err) {
      this.logger.warn(
        `could not remember the booking working set for ${ctx.aiConversationId}: ${this.msg(err)}`,
      );
    }
  }

  /**
   * The ESTABLISHED BOOKING CONTEXT block for a WHATSAPP turn. Always present:
   * its first line is today's date (see `describeToday`), which the model cannot
   * know and which "tomorrow" depends on, whether or not a branch has been
   * worked on yet. The branch / doctor / price lines follow only once the
   * conversation has worked on a branch that still exists and is active.
   *
   * The date is stated in the SELECTED branch's timezone — the zone the
   * availability engine reads a `date` in — else the clinic's first active
   * branch's, else UTC (the public widget's own fallback).
   *
   * Every other line is read from the database now, through the same discovery
   * queries the tools use, so the block can never disagree with a tool result.
   * Ordered most-valuable-first because the budget truncates from the END.
   */
  async describeOwnClinicContext(
    tenantId: string,
    aiConversationId: string,
  ): Promise<string> {
    const session = await this.sessions.get(tenantId, aiConversationId);
    const branchId = this.uuid(session.selectedBranchId);

    const branches = (await this.branches.findAll(tenantId)).filter(
      (b) => b.is_active,
    );
    const branch = branchId
      ? branches.find((b) => b.id === branchId)
      : undefined;

    const header =
      'ESTABLISHED BOOKING CONTEXT (re-read from the database this turn).';
    const clock = `- ${describeToday(safeZone((branch ?? branches[0])?.timezone))}`;
    if (!branch) return [header, clock].join('\n');

    const [doctors, services] = await Promise.all([
      this.discovery.listBranchDoctors(tenantId, branch.id),
      this.discovery.listBranchServices(tenantId, branch.id),
    ]);

    const lines: string[] = [
      `branch: ${this.oneLine(branch.name)}${
        branch.address ? ` (${this.oneLine(branch.address)})` : ''
      } (id ${branch.id})`,
    ];

    const doctorId = this.uuid(session.selectedDoctorId);
    if (doctorId) {
      const doctor = doctors.find((x) => x.id === doctorId);
      lines.push(
        doctor
          ? `doctor last used: ${this.oneLine(doctor.name)} (id ${doctor.id})`
          : 'CLEARED (no longer valid, ask the patient again): doctor',
      );
    }

    const shownServices = services.slice(0, WHATSAPP_CONTEXT_MAX_SERVICES);
    if (shownServices.length) {
      lines.push(
        'services at this branch (price exactly as the clinic published it):',
      );
      for (const s of shownServices) {
        const price =
          s.price == null
            ? 'price NOT PUBLISHED — never a number, never "free"'
            : `price ${s.price}`;
        lines.push(
          `  - ${this.oneLine(s.name)} (id ${s.id}): ${s.durationMinutes} min, ${price}`,
        );
      }
      if (services.length > shownServices.length) {
        lines.push(
          `  (${services.length - shownServices.length} more — call list_clinic_services)`,
        );
      }
    }

    const shownDoctors = doctors.slice(0, WHATSAPP_CONTEXT_MAX_DOCTORS);
    if (shownDoctors.length) {
      lines.push(
        `doctors at this branch: ${shownDoctors
          .map((x) => `${this.oneLine(x.name)} (id ${x.id})`)
          .join('; ')}${
          doctors.length > shownDoctors.length
            ? ` (+${doctors.length - shownDoctors.length} more — call list_clinic_doctors)`
            : ''
        }`,
      );
    }

    const others = branches.filter((b) => b.id !== branchId);
    if (others.length) {
      lines.push(
        `other branches: ${others
          .slice(0, 5)
          .map((b) => `${this.oneLine(b.name)} (id ${b.id})`)
          .join('; ')}`,
      );
    }

    return [
      header,
      clock,
      'These ids and prices came from earlier tool calls in this conversation. Use them directly instead of looking them up again, and never show an id to the patient. For a different branch, call list_clinic_doctors / list_clinic_services with that branch.',
      ...lines.map((l) => (l.startsWith('  ') ? l : `- ${l}`)),
    ].join('\n');
  }

  /** THIS clinic's own active branches — id, name, address only (no phone/timezone). */
  async listClinicBranches(ctx: ToolContext): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    return this.run(
      ctx,
      AI_TOOL.LIST_CLINIC_BRANCHES,
      `clinic_branches:${randomUUID()}`,
      {},
      async () => {
        const all = await this.branches.findAll(ctx.tenantId);
        const branches = all
          .filter((b) => b.is_active)
          .map((b) => ({
            id: b.id,
            name: b.name,
            address: b.address ?? null,
          }));
        return {
          toolResult: { success: true, count: branches.length, branches },
          resultJson: { count: branches.length },
        };
      },
    );
  }

  /**
   * Doctors at one of THIS clinic's own branches, or — F-24 — across every
   * active branch when `branchId` is omitted, so a multi-branch clinic can
   * answer a general "who are your doctors?" without demanding a branch
   * choice first.
   */
  async listClinicDoctors(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    const branchArgPresent =
      args.branchId !== undefined &&
      args.branchId !== null &&
      args.branchId !== '';
    const branchId = branchArgPresent ? this.uuid(args.branchId) : undefined;
    if (branchArgPresent && !branchId) {
      return this.badId('branchId', 'list_clinic_branches');
    }

    return this.run(
      ctx,
      AI_TOOL.LIST_CLINIC_DOCTORS,
      `clinic_doctors:${randomUUID()}`,
      args,
      async () => {
        let doctors: Awaited<
          ReturnType<typeof this.discovery.listTenantDoctors>
        >;
        if (branchId) {
          // Ownership check INSIDE the executor, before the lookup: a branch
          // id from another tenant must refuse plainly (recorded as a normal
          // FAILED_PERMANENT ledger row via AppError, same as getClinicDetails'
          // not-found path) rather than silently returning an empty doctor
          // list — which reads to the model as "this branch has no doctors"
          // and invites a wrong answer to the patient.
          await this.branches.findOne(ctx.tenantId, branchId);
          doctors = await this.discovery.listBranchDoctors(
            ctx.tenantId,
            branchId,
          );
        } else {
          doctors = await this.discovery.listTenantDoctors(ctx.tenantId);
        }
        return {
          toolResult: { success: true, count: doctors.length, doctors },
          resultJson: { branchId: branchId ?? null, count: doctors.length },
        };
      },
    );
  }

  /**
   * Services (with prices) at one of THIS clinic's own branches, or — F-24 —
   * across every active branch when `branchId` is omitted, so a multi-branch
   * clinic can answer a general "what services do you offer?" without
   * demanding a branch choice first.
   */
  async listClinicServices(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    const branchArgPresent =
      args.branchId !== undefined &&
      args.branchId !== null &&
      args.branchId !== '';
    const branchId = branchArgPresent ? this.uuid(args.branchId) : undefined;
    if (branchArgPresent && !branchId) {
      return this.badId('branchId', 'list_clinic_branches');
    }

    return this.run(
      ctx,
      AI_TOOL.LIST_CLINIC_SERVICES,
      `clinic_services:${randomUUID()}`,
      args,
      async () => {
        let services: Awaited<
          ReturnType<typeof this.discovery.listTenantServices>
        >;
        if (branchId) {
          // See listClinicDoctors' identical comment above.
          await this.branches.findOne(ctx.tenantId, branchId);
          services = await this.discovery.listBranchServices(
            ctx.tenantId,
            branchId,
          );
        } else {
          services = await this.discovery.listTenantServices(ctx.tenantId);
        }
        return {
          toolResult: {
            success: true,
            count: services.length,
            ...this.servicesForModel(services),
          },
          resultJson: { branchId: branchId ?? null, count: services.length },
        };
      },
    );
  }

  // ─────────────────────────────── Tools ─────────────────────────────────── //

}

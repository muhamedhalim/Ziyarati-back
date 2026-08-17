import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { AiConversationAccessService } from '../ai/ai-conversation-access.service';
import {
  ConversationSessionService,
  SessionPatch,
} from '../ai-orchestrator/conversation-session.service';
import { AiSession } from '../ai-orchestrator/ai-channel.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/** How far the caller needs the selection to have progressed. */
export type BookingStep =
  | 'clinic'
  | 'branch'
  | 'service'
  | 'doctor'
  | 'slot'
  | 'book';

/**
 * The resolved, server-owned booking context for one public AI turn. Every
 * field is derived from persisted session state plus a live database check —
 * none of it is client- or model-supplied.
 */
export interface PublicBookingContext {
  /** The SELECTED clinic's tenant. Never the conversation's own tenant. */
  tenantId: string;
  branchId: string;
  serviceIds: string[];
  staffId?: string;
  startAt?: string;
  customerId?: string;
  aiConversationId: string;
}

/**
 * The single seam between "a guest is talking to us" and "we are writing into a
 * clinic".
 *
 * THE PROBLEM IT SOLVES: an anonymous visitor's socket is authenticated into
 * the shared `__guest_discovery__` tenant. That tenant is the CONVERSATION
 * context — it owns the chat rows and nothing else. It must never be the tenant
 * a booking is written to, and the visitor must never be able to nominate one
 * either. So the booking tenant is re-derived, on every transactional call,
 * from the branch the visitor actually selected:
 *
 *     selectedBranchId → branches ⋈ tenants ⋈ tenant_settings → tenantId
 *
 * (the same server-side resolution `PublicDiscoveryService.publicAvailability`
 * already uses for read-only availability, generalised and tightened).
 *
 * Consequences that make this safe:
 *  - `tenantId` is never a parameter — not on a tool, not on a DTO, not on a
 *    socket payload. There is no input that can carry it.
 *  - The guest JWT is never reissued, rewritten, or elevated. The two contexts
 *    stay separate for the whole conversation.
 *  - Re-resolving per call means an opt-out, deactivation, or soft-delete that
 *    happens MID-conversation takes effect immediately, instead of a stale
 *    decision persisting because it was cached at selection time.
 *  - `selectedClinicId` is cross-checked against the resolved tenant, so a
 *    tampered pair is caught rather than silently preferring one of them.
 */
@Injectable()
export class PublicBookingContextService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AiConversationAccessService,
    private readonly sessions: ConversationSessionService,
  ) {}

  /**
   * Resolves the owning clinic of a branch — the ONLY way a public booking
   * tenant is ever produced.
   *
   * Fails closed on every dimension: the branch must be active and not
   * soft-deleted, and its clinic must be APPROVED, active, not soft-deleted,
   * and have opted in to public booking.
   */
  async resolveTenantFromBranch(branchId: string): Promise<string> {
    if (!branchId) throw this.notFound();

    const rows: { tenant_id: string }[] = await this.dataSource.query(
      `SELECT b."tenantId" AS tenant_id
         FROM branches b
         JOIN tenants t ON t.id = b."tenantId"
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE b.id = $1
          AND b.is_active = true
          AND b.deleted_at IS NULL
          AND t.approval_status = 'APPROVED'
          AND t.is_active = true
          AND t.deleted_at IS NULL
          AND COALESCE(ts.public_booking_enabled, false) = true
        LIMIT 1`,
      [branchId],
    );

    const tenantId = rows[0]?.tenant_id;
    if (!tenantId) throw this.notFound();
    return tenantId;
  }

  /** The conversation's persisted selections, after an ownership check. */
  async getSelection(
    conversationTenantId: string,
    aiConversationId: string,
    principal: AuthenticatedUser | null | undefined,
  ): Promise<AiSession> {
    await this.access.assertAccess(
      conversationTenantId,
      aiConversationId,
      principal,
    );
    return this.sessions.get(conversationTenantId, aiConversationId);
  }

  /**
   * The ONLY writer of the `selected*` keys. Callers (the `select_*` tools)
   * must have validated the ids against live data first — this method records
   * a decision, it does not vet one.
   *
   * AI-006: the patch type is `Pick<SessionPatch, ...>`, not
   * `Pick<AiSession, ...>` — a thin pass-through widening so a caller (e.g.
   * `selectClinic`'s reset) may set a field to `SESSION_UNSET` as well as its
   * normal value. No merge logic is duplicated here (FR-104); `clean()`'s
   * sentinel handling in `ConversationSessionService.patch()` does the work.
   */
  async patchSelection(
    conversationTenantId: string,
    aiConversationId: string,
    patch: Pick<
      SessionPatch,
      | 'selectedClinicId'
      | 'selectedBranchId'
      | 'selectedDoctorId'
      | 'selectedServiceIds'
      | 'selectedStartAt'
      | 'bookingCustomerId'
    >,
  ): Promise<AiSession> {
    return this.sessions.patch(conversationTenantId, aiConversationId, patch);
  }

  /**
   * Builds the booking context for a turn, asserting the selection has reached
   * `need`. Throws a caller-friendly `UNPROCESSABLE_ENTITY` when a step is
   * simply missing (the model can recover by asking for it), and the uniform
   * `NOT_FOUND` when something looks tampered or has become unavailable.
   */
  async requireContext(
    conversationTenantId: string,
    aiConversationId: string,
    principal: AuthenticatedUser | null | undefined,
    need: BookingStep,
  ): Promise<PublicBookingContext> {
    const session = await this.getSelection(
      conversationTenantId,
      aiConversationId,
      principal,
    );

    const branchId = session.selectedBranchId;
    if (!branchId) throw this.missing('branch');

    // Re-derived every call, never read from the session: the session records
    // WHICH branch, the database decides which clinic that is and whether it is
    // still bookable right now.
    const tenantId = await this.resolveTenantFromBranch(branchId);

    // Tamper check: the recorded clinic and the branch's real owner must agree.
    // They can only diverge if something wrote a selection it did not validate.
    if (session.selectedClinicId && session.selectedClinicId !== tenantId) {
      throw this.notFound();
    }

    const serviceIds = session.selectedServiceIds ?? [];
    if (this.reached(need, 'service') && serviceIds.length === 0) {
      throw this.missing('service');
    }
    if (this.reached(need, 'doctor') && !session.selectedDoctorId) {
      throw this.missing('doctor');
    }
    if (this.reached(need, 'slot') && !session.selectedStartAt) {
      throw this.missing('slot');
    }

    return {
      tenantId,
      branchId,
      serviceIds,
      staffId: session.selectedDoctorId,
      startAt: session.selectedStartAt,
      customerId: session.bookingCustomerId,
      aiConversationId,
    };
  }

  /** Step ordering — is `need` at or past `step`? */
  private reached(need: BookingStep, step: BookingStep): boolean {
    const order: BookingStep[] = [
      'clinic',
      'branch',
      'service',
      'doctor',
      'slot',
      'book',
    ];
    return order.indexOf(need) >= order.indexOf(step);
  }

  private missing(step: string): AppError {
    return new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message: `No ${step} has been selected for this booking yet.`,
      publicContext: { missingStep: step },
    });
  }

  /**
   * One uniform rejection for "no such branch", "clinic not approved",
   * "clinic has not enabled public booking" and "selection looks tampered".
   * Distinguishing them would tell an anonymous prober which clinics exist and
   * what state they are in.
   */
  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, {
      message: 'This clinic is not available for online booking.',
    });
  }
}

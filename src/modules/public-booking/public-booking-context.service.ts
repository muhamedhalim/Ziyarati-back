import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { AiConversationAccessService } from '../ai/ai-conversation-access.service';
import {
  ConversationSessionService,
  SessionPatch,
} from '../ai-orchestrator/conversation-session.service';
import { AiSession } from '../ai-orchestrator/ai-channel.constants';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
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
    @InjectRepository(AiConversation)
    private readonly aiConversations: Repository<AiConversation>,
  ) {}

  /**
   * Spec 014 (Clinic Platform Completion) — T065 (S4, R16). The deterministic
   * public booking flow (no AI turn, no `aiConversationId` from a model) still
   * needs a session key to call `getSelection`/`patchSelection`/`requireContext`
   * with — those are hard-wired to a conversation row. Reuses the row PURELY
   * as a session-state container, exactly as `AiOrchestratorService.prepare()`
   * does for a fresh WS turn (`start()` + `patch({ guestSubject })`), so this
   * writes no second context store.
   *
   * `existingConversationId` (carried by the caller across requests — the
   * controller's own session cookie, since nothing server-side maps
   * `guestId → conversationId`) is reused only if it still resolves and is
   * still owned by this exact guest; anything else — wrong owner, deleted,
   * never existed — silently falls through to minting a fresh one rather than
   * erroring, since "the session expired" should feel like "start a new one",
   * not a failure.
   */
  async ensureConversation(
    guestTenantId: string,
    guestId: string,
    existingConversationId?: string,
  ): Promise<string> {
    if (existingConversationId) {
      try {
        await this.access.assertAccess(guestTenantId, existingConversationId, {
          id: guestId,
          tenantId: guestTenantId,
          roles: [],
          permissions: [],
          guest: true,
        });
        return existingConversationId;
      } catch {
        // Not this guest's, or gone — fall through to a fresh session.
      }
    }

    const conv = await this.aiConversations.save(
      this.aiConversations.create({
        tenant: { id: guestTenantId } as Tenant,
        status: AI_CONVERSATION_STATUS.ACTIVE,
      }),
    );
    await this.sessions.patch(guestTenantId, conv.id, {
      guestSubject: guestId,
    });
    return conv.id;
  }

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
      | 'selectedCityId'
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
   * A server-validated, human-readable snapshot of what this conversation has
   * already established — the block the model is shown at the top of every
   * public turn.
   *
   * WHY THIS EXISTS. Tool results live for exactly one turn: they are fed back
   * inside the tool-calling loop and then discarded, because only `USER` and
   * `ASSISTANT` rows are persisted to `ai_messages` and only those are replayed
   * as history. So on turn N+1 the model had no memory that a city, clinic or
   * branch had ever been chosen — the ids existed on `ai_conversations.session`
   * the whole time, but nothing ever put them in the prompt. The model did the
   * only thing it could and started discovery over from `list_cities`, which is
   * why "whatever is available with you" after a clinic had been picked came
   * back as "no clinics available".
   *
   * WHAT MAKES IT TRUSTWORTHY. Nothing here is echoed from the session as
   * recorded. Every id is re-read from the database through the SAME eligibility
   * predicate the booking itself uses, so:
   *  - a clinic that opted out, was deactivated or soft-deleted mid-conversation
   *    drops out of the block on the very next turn rather than lingering;
   *  - names shown to the visitor are the clinic's real DB names, never a name
   *    the model or a Knowledge document supplied; and
   *  - a selection that no longer resolves is reported as CLEARED, so the model
   *    is told to ask again instead of quietly booking against a stale id.
   *
   * Returns `null` when nothing has been established yet — a first turn adds no
   * block at all, and costs no prompt budget.
   */
  async describeSelection(
    conversationTenantId: string,
    aiConversationId: string,
    principal: AuthenticatedUser | null | undefined,
  ): Promise<string | null> {
    let session: AiSession;
    try {
      session = await this.getSelection(
        conversationTenantId,
        aiConversationId,
        principal,
      );
    } catch {
      // No access / no conversation ⇒ nothing to describe. Never throws into a
      // turn: an unavailable context block must degrade to "no context", not to
      // a failed reply.
      return null;
    }

    const stale: string[] = [];

    // The clinic is resolved from the BRANCH when one is recorded (the branch is
    // authoritative — it is what the booking tenant is derived from), and from
    // the recorded clinic id otherwise. Resolved BEFORE the date line, because
    // the branch's timezone is what "today" has to mean once one is selected.
    const branch = session.selectedBranchId
      ? await this.branchSnapshot(session.selectedBranchId)
      : null;
    if (session.selectedBranchId && !branch) stale.push('branch');

    // The availability engine reads every `date` as the BRANCH's local calendar
    // date, so that is the clock the model must resolve "tomorrow" against.
    // Using the visitor's browser timezone here (the previous behaviour) puts
    // the two a day apart whenever the visitor and the clinic are on opposite
    // sides of midnight — the model then asks for a day the patient did not
    // mean and is told there is nothing free.
    const lines: string[] = [this.today(branch?.timezone ?? session.timezone)];

    if (session.selectedCityId) {
      const city = await this.cityName(session.selectedCityId);
      if (city) lines.push(`city: ${city} (id ${session.selectedCityId})`);
      else stale.push('city');
    }

    const clinicId = branch?.tenantId ?? session.selectedClinicId;
    if (clinicId) {
      // Cross-check: a recorded clinic that disagrees with the branch's real
      // owner means something wrote a selection it did not validate. Report
      // NOTHING rather than a half-trusted pair.
      if (
        branch &&
        session.selectedClinicId &&
        session.selectedClinicId !== branch.tenantId
      ) {
        return null;
      }
      const clinic = await this.clinicName(clinicId);
      if (clinic) {
        lines.push(`clinic: ${clinic} (id ${clinicId})`);
        lines.push(
          'clinic bookability: CONFIRMED by the database (approved, active, public booking enabled).',
        );
      } else {
        stale.push('clinic');
      }
    }

    if (branch) {
      const where = [branch.city, branch.address].filter(Boolean).join(' — ');
      lines.push(
        `branch: ${branch.name}${where ? ` (${where})` : ''} (id ${branch.id})`,
      );
    }

    if (session.selectedServiceIds?.length && branch) {
      const names = await this.serviceNames(
        branch.tenantId,
        session.selectedServiceIds,
      );
      if (names.length) lines.push(`services: ${names.join(', ')}`);
      else stale.push('service');
    }

    if (session.selectedDoctorId && branch) {
      const doctor = await this.doctorName(
        branch.tenantId,
        session.selectedDoctorId,
      );
      if (doctor)
        lines.push(`doctor: ${doctor} (id ${session.selectedDoctorId})`);
      else stale.push('doctor');
    }

    if (session.selectedStartAt) {
      lines.push(`slot: ${session.selectedStartAt}`);
    }

    const next = branch
      ? 'The branch is already selected — go straight to list_branch_services / list_branch_doctors / search_public_availability. Do NOT call list_cities or search_clinics again.'
      : clinicId
        ? 'The clinic is already selected — call select_branch (or get_clinic_details to list its branches). Do NOT call list_cities or search_clinics again.'
        : session.selectedCityId
          ? 'A city is already chosen — call search_clinics with that cityId. Do NOT call list_cities again.'
          : 'Nothing has been selected yet — start from list_cities or search_clinics.';

    return [
      'ESTABLISHED BOOKING CONTEXT (server-verified against the database this turn).',
      'These are facts, not suggestions. Reuse them; never re-derive them and never contradict them.',
      ...lines.map((l) => `- ${l}`),
      ...(stale.length
        ? [
            `- CLEARED (no longer valid, ask the visitor again): ${stale.join(', ')}`,
          ]
        : []),
      next,
    ].join('\n');
  }

  /**
   * Today's date, in the visitor's timezone when the session recorded one.
   *
   * The model had no clock. Asked for "tomorrow", it produced a date from its
   * training data — observed live as a `search_public_availability` call for
   * `2023-10-29`, which of course returned no windows, and the assistant then
   * told the visitor there was nothing available. The clinic, branch and doctor
   * were all correct; only the day was invented.
   *
   * The server knows the date, so the server states it. Emitted on every public
   * turn, including the first, because a relative date can be the very first
   * thing a visitor says ("can I come tomorrow?").
   */
  private today(timezone?: string): string {
    const now = new Date();
    const zone = timezone?.trim() || 'UTC';
    let date: string;
    try {
      date = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
    } catch {
      // An unrecognised IANA zone must not cost the whole block.
      date = now.toISOString().slice(0, 10);
    }
    const weekday = (() => {
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          weekday: 'long',
        }).format(now);
      } catch {
        return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(
          now,
        );
      }
    })();
    return `today: ${date} (${weekday}, ${zone}). Resolve "today", "tomorrow" and every other relative date from THIS, never from memory, and pass the result as YYYY-MM-DD.`;
  }

  /** Branch + its clinic + city, through the public eligibility predicate. */
  private async branchSnapshot(branchId: string): Promise<{
    id: string;
    name: string;
    address: string | null;
    city: string | null;
    tenantId: string;
    timezone: string;
  } | null> {
    const rows = await this.dataSource.query(
      `SELECT b.id, b.name, b.address, b."tenantId" AS tenant_id, b.timezone,
              COALESCE(c.name_ar, c.name_en) AS city
         FROM branches b
         JOIN tenants t ON t.id = b."tenantId"
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
         LEFT JOIN cities c ON c.id = b.city_id
        WHERE b.id = $1::uuid
          AND b.is_active = true
          AND b.deleted_at IS NULL
          AND t.approval_status = 'APPROVED'
          AND t.is_active = true
          AND t.deleted_at IS NULL
          AND COALESCE(ts.public_booking_enabled, false) = true
        LIMIT 1`,
      [branchId],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id as string,
          name: row.name as string,
          address: (row.address as string) ?? null,
          city: (row.city as string) ?? null,
          tenantId: row.tenant_id as string,
          timezone: (row.timezone as string) || 'UTC',
        }
      : null;
  }

  /** The clinic's REAL name — only if it is still publicly bookable right now. */
  private async clinicName(clinicId: string): Promise<string | null> {
    const rows = await this.dataSource.query(
      `SELECT t.name
         FROM tenants t
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE t.id = $1::uuid
          AND t.approval_status = 'APPROVED'
          AND t.is_active = true
          AND t.deleted_at IS NULL
          AND COALESCE(ts.public_booking_enabled, false) = true
        LIMIT 1`,
      [clinicId],
    );
    return (rows[0]?.name as string) ?? null;
  }

  private async cityName(cityId: string): Promise<string | null> {
    const rows = await this.dataSource.query(
      `SELECT COALESCE(name_ar, name_en) AS name FROM cities WHERE id = $1::uuid LIMIT 1`,
      [cityId],
    );
    return (rows[0]?.name as string) ?? null;
  }

  private async serviceNames(
    tenantId: string,
    serviceIds: string[],
  ): Promise<string[]> {
    if (!serviceIds.length) return [];
    const rows = await this.dataSource.query(
      `SELECT name FROM services
        WHERE "tenantId" = $1::uuid AND id = ANY($2::uuid[])
          AND is_active = true AND deleted_at IS NULL
        ORDER BY name`,
      [tenantId, serviceIds],
    );
    return rows.map((r: Record<string, unknown>) => r.name as string);
  }

  private async doctorName(
    tenantId: string,
    staffId: string,
  ): Promise<string | null> {
    const rows = await this.dataSource.query(
      `SELECT COALESCE(u.full_name, sp.title, 'Doctor') AS name
         FROM staff_profiles sp
         LEFT JOIN users u ON u.id = sp.user_id AND u.deleted_at IS NULL AND u.is_active = true
        WHERE sp.id = $2::uuid
          AND sp."tenantId" = $1::uuid
          AND sp.deleted_at IS NULL
          AND sp.is_available_for_booking = true
        LIMIT 1`,
      [tenantId, staffId],
    );
    return (rows[0]?.name as string) ?? null;
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

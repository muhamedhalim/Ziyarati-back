import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { TenantApprovalStatus } from '../../entities/enums';
import { FreeAccessOverrideService } from '../subscription-billing/free-access-override.service';
import { AiMemoryService } from '../ai-memory/ai-memory.service';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import { AppError, ErrorCode } from '../../common/errors';
import { ttlToMs } from '../../common/utils/ttl';

/** Slug of the singleton system tenant that hosts anonymous/guest conversations. */
const DISCOVERY_TENANT_SLUG = '__guest_discovery__';

/**
 * Contact address for that singleton. `tenants.contact_email` is NOT NULL and
 * UNIQUE, so the row cannot be created without one — a fixed, never-routable
 * `.internal` address is safe here precisely because the tenant is a singleton.
 */
const DISCOVERY_TENANT_EMAIL = 'guest-discovery@system.internal';

export interface GuestToken {
  token: string;
  guestId: string;
  tenantId: string;
  maxAgeMs: number;
}

/**
 * `resolveSession()`'s result additionally says whether a NEW token was
 * minted, so the controller knows whether the `guest_token` cookie needs to
 * be (re)written at all — reusing a still-valid identity must not touch the
 * cookie ("do not unnecessarily change the guest_token").
 */
export interface ResolvedGuestSession extends GuestToken {
  isNew: boolean;
}

/**
 * Guest (anonymous) session architecture (Feature 1).
 *
 * A visitor with no account chats under a SINGLETON, data-less "Guest Discovery"
 * tenant. We mint a normal access JWT scoped to that tenant + a random `guestId`
 * (so the EXISTING WebSocket gateway + orchestrator + engine run UNCHANGED — no
 * gateway auth change, no AiConversation/AiExecution duplication). The discovery
 * tenant carries an unlimited free-access override so guest turns are unmetered.
 *
 * The guest token has NO roles/permissions, so it can only do what the AI socket
 * allows under a tenant that holds no patient/clinic data — full tenant isolation
 * is preserved. On booking/conversion, the guest conversation's history is
 * summarised into the patient's tenant memory (reusing AiMemoryService).
 */
@Injectable()
export class GuestSessionService {
  private readonly logger = new Logger(GuestSessionService.name);
  /**
   * Memoized id of the single discovery tenant (L10 —
   * docs/CACHING_QUEUES_AUDIT.md corrects the original finding here: this is
   * a scalar memoizing ONE well-known singleton row, not a per-key map, so
   * it is not "unbounded" in any sense — it holds exactly one value for the
   * life of the process, same footprint on day one as on day one thousand).
   */
  private discoveryTenantId: string | null = null;

  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly overrides: FreeAccessOverrideService,
    private readonly memory: AiMemoryService,
    @InjectRepository(AiConversation)
    private readonly conversations: Repository<AiConversation>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  /** Find-or-create the guest discovery tenant + ensure it is unmetered. Cached. */
  async ensureDiscoveryTenant(): Promise<string> {
    if (this.discoveryTenantId) return this.discoveryTenantId;

    let tenant = await this.tenants.findOne({
      where: { slug: DISCOVERY_TENANT_SLUG },
    });
    if (!tenant) {
      tenant = await this.tenants.save(
        this.tenants.create({
          name: 'Guest Discovery',
          slug: DISCOVERY_TENANT_SLUG,
          // `tenants.contact_email` is NOT NULL + UNIQUE. Omitting it made this
          // insert fail outright on any database that did not already carry the
          // singleton row — i.e. every fresh deployment — which took down the
          // whole anonymous flow, since `resolveSession()` starts here. Fixed
          // address, same `.internal` convention as the other synthetic
          // identities (`ai-bot@bot.internal`, the WhatsApp contact addresses):
          // never routable, and unique by construction for a singleton row.
          contact_email: DISCOVERY_TENANT_EMAIL,
          is_active: true,
          approval_status: TenantApprovalStatus.APPROVED,
        }),
      );
      this.logger.log(`Created guest discovery tenant ${tenant.id}`);
    }
    // Unmetered access so anonymous turns are never blocked by plan quotas.
    if (!(await this.overrides.hasActive(tenant.id))) {
      await this.overrides
        .grant(tenant.id, {
          reason: 'Guest discovery (system tenant)',
          durationDays: null,
        })
        .catch((err) =>
          this.logger.warn(`override grant skipped: ${(err as Error).message}`),
        );
    }
    this.discoveryTenantId = tenant.id;
    return tenant.id;
  }

  /** Last-resort fallback only — every real deployment relies on the
   * Joi-validated default ('1d', env.validation.ts) instead. Reached only
   * when GUEST_SESSION_TTL is explicitly set to something `ttlToMs` can't
   * parse. */
  private static readonly FALLBACK_TTL = '1d';

  /**
   * Idempotent guest-session resolution (guest-identity-churn fix).
   *
   * A visitor who already carries a valid `guest_token` keeps the SAME
   * `guestId` — the session is neither re-minted nor re-cookied. Only a
   * missing, expired, malformed, or foreign-tenant token causes a new
   * identity to be minted. This is what makes `POST /public/guest/session`
   * safe to call on every widget mount: minting unconditionally used to
   * orphan `session.guestSubject` on any conversation the visitor already
   * had cached client-side — `AiConversationAccessService` then correctly,
   * and by design, refused it as "AI conversation not found" on the very
   * next turn. This method only decides whether to REUSE or MINT an
   * identity; it never changes who a conversation belongs to, and every
   * downstream ownership/anti-enumeration check is untouched.
   */
  async resolveSession(existingToken?: string): Promise<ResolvedGuestSession> {
    const tenantId = await this.ensureDiscoveryTenant();
    const reused = await this.tryReuse(existingToken, tenantId);
    if (reused) return { ...reused, isNew: false };
    return { ...(await this.mint(tenantId)), isNew: true };
  }

  /**
   * Verifies a presented `guest_token` and, only if it is genuinely still a
   * valid guest credential for THIS discovery tenant, returns it unchanged.
   * Same secret + same verification rules `convert()`/`WsAuthService` use —
   * an invalid/foreign/expired token is never an error here, it just means
   * "nothing to reuse" (falls through to minting a fresh identity).
   */
  private async tryReuse(
    token: string | undefined,
    tenantId: string,
  ): Promise<GuestToken | null> {
    if (!token) return null;
    const accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
    let claims: { sub?: string; tenantId?: string; guest?: boolean };
    try {
      claims = await this.jwt.verifyAsync(token, { secret: accessSecret });
    } catch {
      return null;
    }
    if (!claims.guest || !claims.sub || claims.tenantId !== tenantId) {
      return null;
    }
    return { token, guestId: claims.sub, tenantId, maxAgeMs: this.ttlMs() };
  }

  /** Mints a brand-new guest identity — the previous unconditional behavior,
   * now reached only when nothing valid was presented to reuse. */
  private async mint(tenantId: string): Promise<GuestToken> {
    const guestId = randomUUID();
    const ttl = this.resolveTtl();
    const token = await this.jwt.signAsync(
      { sub: guestId, tenantId, guest: true },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: ttl as unknown as JwtSignOptions['expiresIn'],
      },
    );
    return { token, guestId, tenantId, maxAgeMs: ttlToMs(ttl) };
  }

  /** Cookie Max-Age for the CURRENTLY configured TTL, derived from the exact
   * same string a fresh mint would sign with — the JWT and its cookie can
   * never drift apart (mirrors CookieService's own ttlToMs usage). */
  private ttlMs(): number {
    return ttlToMs(this.resolveTtl());
  }

  /** Falls back to a safe default rather than letting a misconfigured
   * duration reach `jwt.signAsync` (which throws on a bad string) or produce
   * a cookie Max-Age of 0 (which deletes the cookie immediately, breaking
   * every guest turn). Logs once per call so a bad deploy is diagnosable. */
  private resolveTtl(): string {
    const configured = this.config.get<string>(
      'GUEST_SESSION_TTL',
      GuestSessionService.FALLBACK_TTL,
    );
    if (ttlToMs(configured) > 0) return configured;
    this.logger.warn(
      `GUEST_SESSION_TTL="${configured}" is not a valid duration (e.g. "1d", "12h") — falling back to ${GuestSessionService.FALLBACK_TTL}`,
    );
    return GuestSessionService.FALLBACK_TTL;
  }

  /**
   * Convert a guest conversation into a patient conversation (Feature 1) when the
   * visitor books / becomes a patient — WITHOUT losing history: the guest thread's
   * key points are summarised into the PATIENT tenant's long-term memory (reuses
   * AiMemoryService). The original guest messages remain intact under the
   * discovery tenant.
   *
   * SECURITY (FND-001). Two independent trusted anchors, neither caller-asserted:
   *  - TARGET tenant — from the authenticated principal (supplied by the caller
   *    of this method as `targetTenantId`, which the controller reads from
   *    `TenantContextService.requireTenantId()`). Never from the request body.
   *  - SOURCE conversation — proven to belong to the presented `guest_token` by
   *    comparing the conversation's recorded `session.guestSubject` against the
   *    token's verified `sub`. This is what prevents one guest converting
   *    another guest's conversation inside the shared discovery tenant.
   *
   * Every failure below raises the SAME not-found error so a caller cannot learn
   * whether a session, conversation, binding or prior conversion exists.
   */
  async convert(
    guestConversationId: string,
    targetTenantId: string,
    guestToken: string | undefined,
    customerId?: string,
    actorUserId?: string,
  ) {
    // (2) A guest token must be presented.
    if (!guestToken) throw this.notFound();

    // (3) Verify signature + expiry, and require the guest marker. Secret
    // resolved BEFORE the try/catch (ZT-007) so a missing configuration
    // value fails loudly instead of being swallowed into the same
    // not-found response a forged/expired token produces.
    const accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
    let claims: { sub?: string; tenantId?: string; guest?: boolean };
    try {
      claims = await this.jwt.verifyAsync(guestToken, { secret: accessSecret });
    } catch {
      throw this.notFound();
    }
    if (!claims?.guest || !claims.sub || !claims.tenantId)
      throw this.notFound();

    // (4) The token must belong to the discovery tenant.
    const discoveryTenantId = await this.ensureDiscoveryTenant();
    if (claims.tenantId !== discoveryTenantId) throw this.notFound();

    // (5) Load the source conversation, scoped to the discovery tenant.
    const conversation = await this.conversations.findOne({
      where: { id: guestConversationId, tenant: { id: discoveryTenantId } },
    });
    if (!conversation) throw this.notFound();

    // (6) Ownership: the conversation must be bound to THIS guest session.
    // Absent binding (pre-existing conversations) is treated as not owned.
    const boundSubject = (
      conversation.session as { guestSubject?: string } | null
    )?.guestSubject;
    if (!boundSubject || boundSubject !== claims.sub) throw this.notFound();

    // (7) Claim the conversion atomically. A conditional UPDATE — never
    // `save()`, which is a read-modify-write and would lose the update under
    // concurrency. Zero affected rows means someone else already converted it.
    const claimed = await this.conversations
      .createQueryBuilder()
      .update(AiConversation)
      .set({ status: AI_CONVERSATION_STATUS.CONVERTED })
      .where('id = :id', { id: guestConversationId })
      .andWhere('"tenantId" = :tenantId', { tenantId: discoveryTenantId })
      .andWhere('status = :active', { active: AI_CONVERSATION_STATUS.ACTIVE })
      .execute();
    if ((claimed.affected ?? 0) === 0) throw this.notFound();

    // (8)+(9) Read scoped to the discovery tenant; write to the target tenant.
    const summary = await this.memory.summarizeConversation(
      targetTenantId,
      guestConversationId,
      customerId,
      discoveryTenantId,
    );

    // (10) AI-018 (FR-037-039): exactly one audit entry per successful
    // conversion. Best-effort — a write failure must never fail or roll
    // back the conversion itself (FR-039), so it runs after the claim and
    // the summarization are already committed, guarded by its own
    // try/catch (same pattern as auth.service.ts's protection-event audit).
    await this.auditConversion(
      targetTenantId,
      actorUserId,
      guestConversationId,
      summary?.id,
    );

    return { converted: true, memoryId: summary?.id ?? null };
  }

  /**
   * AI-018: writes the guest→patient conversion's audit entry.
   * `entity_type`/`entity_id` name whichever record resulted — the created
   * memory when summarization produced one, otherwise the converted
   * conversation itself (data-model.md §Entity 4). Never carries message
   * content (FR-088) — identifiers and the outcome only.
   */
  private async auditConversion(
    targetTenantId: string,
    actorUserId: string | undefined,
    guestConversationId: string,
    memoryId: string | undefined,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: targetTenantId } as Tenant,
          user: actorUserId ? ({ id: actorUserId } as User) : undefined,
          action: 'guest.conversion.converted',
          entity_type: memoryId ? 'ai_memory' : 'ai_conversation',
          entity_id: memoryId ?? guestConversationId,
          new_values: { guestConversationId, memoryId: memoryId ?? null },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Guest-conversion audit write failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * The single rejection used by every ownership failure mode. Identical code and
   * message throughout, so the endpoint is not an existence oracle (SR-011).
   */
  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, {
      message: 'Guest conversation not found',
    });
  }
}

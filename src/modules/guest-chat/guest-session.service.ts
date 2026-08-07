import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { TenantApprovalStatus } from '../../entities/enums';
import { FreeAccessOverrideService } from '../subscription-billing/free-access-override.service';
import { AiMemoryService } from '../ai-memory/ai-memory.service';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import { AppError, ErrorCode } from '../../common/errors';

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
          // whole anonymous flow, since `createSession()` starts here. Fixed
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

  /** Mint a guest session token (scoped to the discovery tenant). */
  async createSession(): Promise<GuestToken> {
    const tenantId = await this.ensureDiscoveryTenant();
    const guestId = randomUUID();
    const ttl = this.config.get<string>('GUEST_SESSION_TTL', '1d');
    const token = await this.jwt.signAsync(
      { sub: guestId, tenantId, guest: true },
      {
        secret: this.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: ttl as unknown as JwtSignOptions['expiresIn'],
      },
    );
    return { token, guestId, tenantId, maxAgeMs: 24 * 60 * 60 * 1000 };
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
  ) {
    // (2) A guest token must be presented.
    if (!guestToken) throw this.notFound();

    // (3) Verify signature + expiry, and require the guest marker.
    let claims: { sub?: string; tenantId?: string; guest?: boolean };
    try {
      claims = await this.jwt.verifyAsync(guestToken, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      });
    } catch {
      throw this.notFound();
    }
    if (!claims?.guest || !claims.sub || !claims.tenantId) throw this.notFound();

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
    const boundSubject = (conversation.session as { guestSubject?: string } | null)?.guestSubject;
    if (!boundSubject || boundSubject !== claims.sub) throw this.notFound();

    // (7) Claim the conversion atomically. A conditional UPDATE — never
    // `save()`, which is a read-modify-write and would lose the update under
    // concurrency. Zero affected rows means someone else already converted it.
    const claimed = await this.conversations
      .createQueryBuilder()
      .update(AiConversation)
      .set({ status: AI_CONVERSATION_STATUS.CONVERTED })
      .where('id = :id', { id: guestConversationId })
      .andWhere('tenant_id = :tenantId', { tenantId: discoveryTenantId })
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
    return { converted: true, memoryId: summary?.id ?? null };
  }

  /**
   * The single rejection used by every ownership failure mode. Identical code and
   * message throughout, so the endpoint is not an existence oracle (SR-011).
   */
  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, { message: 'Guest conversation not found' });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantApprovalStatus } from '../../entities/enums';
import { FreeAccessOverrideService } from '../subscription-billing/free-access-override.service';
import { AiMemoryService } from '../ai-memory/ai-memory.service';

/** Slug of the singleton system tenant that hosts anonymous/guest conversations. */
const DISCOVERY_TENANT_SLUG = '__guest_discovery__';

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
  private discoveryTenantId: string | null = null;

  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly overrides: FreeAccessOverrideService,
    private readonly memory: AiMemoryService,
  ) {}

  /** Find-or-create the guest discovery tenant + ensure it is unmetered. Cached. */
  async ensureDiscoveryTenant(): Promise<string> {
    if (this.discoveryTenantId) return this.discoveryTenantId;

    let tenant = await this.tenants.findOne({ where: { slug: DISCOVERY_TENANT_SLUG } });
    if (!tenant) {
      tenant = await this.tenants.save(
        this.tenants.create({
          name: 'Guest Discovery',
          slug: DISCOVERY_TENANT_SLUG,
          is_active: true,
          approval_status: TenantApprovalStatus.APPROVED,
        }),
      );
      this.logger.log(`Created guest discovery tenant ${tenant.id}`);
    }
    // Unmetered access so anonymous turns are never blocked by plan quotas.
    if (!(await this.overrides.hasActive(tenant.id))) {
      await this.overrides
        .grant(tenant.id, { reason: 'Guest discovery (system tenant)', durationDays: null })
        .catch((err) => this.logger.warn(`override grant skipped: ${(err as Error).message}`));
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
        secret: this.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
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
   * discovery tenant. Returns the created memory (or null when nothing to carry).
   */
  async convert(guestConversationId: string, targetTenantId: string, customerId?: string) {
    const summary = await this.memory.summarizeConversation(targetTenantId, guestConversationId, customerId);
    return { converted: true, memoryId: summary?.id ?? null };
  }
}

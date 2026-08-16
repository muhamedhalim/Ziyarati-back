import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { AI_BOT_PERMISSIONS, ROLE } from '../../rbac/rbac.constants';

import { AuthService } from '../auth/auth.service';
import { RolesService } from '../auth/roles.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * `users.email` is unique GLOBALLY (`uq_user_email_global`, migration
 * `1730035000000`), not per tenant — see the docblock on `botEmailFor` below.
 * RFC 5233 sub-addressing derives a distinct, deterministic address per
 * tenant from this fixed local-part/domain, so every tenant gets its own bot
 * user row without a global collision and without any schema change.
 */
const BOT_EMAIL_BASE = 'ai-bot';
const BOT_EMAIL_DOMAIN = 'bot.internal';
const BOT_ROLE_SLUG = ROLE.AI_BOT;

/**
 * The tenant-qualified bot address (RFC 5233 sub-addressing, R10):
 * `ai-bot+<tenantId>@bot.internal`. Derived from the tenant id at every call
 * site — the lookup and the insert must always agree, or a legitimate bot
 * user becomes unfindable.
 */
function botEmailFor(tenantId: string): string {
  return `${BOT_EMAIL_BASE}+${tenantId}@${BOT_EMAIL_DOMAIN}`;
}

/**
 * How long a cached principal is trusted before being re-read from the DB
 * (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md H4). Previously this
 * cache had NO TTL at all — a super-admin revoking an `ai_bot` role
 * permission (e.g. after an incident) would leave every already-running
 * API/worker process granting the OLD permission set until it restarted.
 * 60s bounds that window without meaningfully increasing DB load (the lookup
 * is three cheap queries, and WhatsApp turns are seconds apart at most).
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  principal: AuthenticatedUser;
  cachedAt: number;
}

/**
 * Every tenant's dedicated AI Bot Actor — a REAL `users` row with a REAL,
 * minimally-scoped role, created lazily on first use via the EXISTING
 * auth/RBAC services (`RolesService`, `AuthService.buildAuthenticatedUser`) —
 * no parallel identity system, no bypassed guards. Channels that drive AI
 * turns without a logged-in human (WhatsApp today) restore this principal via
 * `TenantContextService.run()` before calling the orchestrator, so every
 * downstream check (tool permission gating, `actorUserId` on bookings) sees a
 * real, auditable actor instead of an anonymous context.
 */
@Injectable()
export class WhatsappBotActorService {
  private readonly logger = new Logger('WhatsappBotActorService');
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly roles: RolesService,
    private readonly auth: AuthService,
  ) {}

  /** Find-or-create the tenant's bot user + role + assignment; cached per tenant with a bounded TTL. */
  async ensureBotActor(tenantId: string): Promise<AuthenticatedUser> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS)
      return cached.principal;

    const userId = await this.ensureBotUser(tenantId);
    const roleId = await this.ensureBotRole(tenantId);
    await this.ensureAssignment(userId, roleId, tenantId);

    // Reuse the EXACT same live roles/permissions lookup the REST JwtStrategy
    // and WsAuthService use — no second principal-building path.
    const principal = await this.auth.buildAuthenticatedUser(userId);
    this.cache.set(tenantId, { principal, cachedAt: Date.now() });
    return principal;
  }

  /**
   * Explicit invalidation for a caller that just changed this tenant's bot
   * permissions and does not want to wait out the TTL (e.g. an admin action
   * with an immediate-effect expectation). Safe to call even when nothing is
   * cached yet.
   */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async ensureBotUser(tenantId: string): Promise<string> {
    const existing = await this.users.findOne({
      where: { tenant: { id: tenantId }, email: botEmailFor(tenantId) },
    });
    if (existing) return existing.id;

    const created = await this.users.save(
      this.users.create({
        tenant: { id: tenantId } as Tenant,
        email: botEmailFor(tenantId),
        full_name: 'AI Assistant',
        is_active: true,
        // No password — the bot never logs in via credentials, only ever
        // acted-as by trusted server code restoring its principal directly.
      }),
    );
    this.logger.log(`created AI bot user ${created.id} for tenant ${tenantId}`);
    return created.id;
  }

  private async ensureBotRole(tenantId: string): Promise<string> {
    const existing = await this.roles.findAll(tenantId);
    const found = existing.find(
      (r) => r.slug === BOT_ROLE_SLUG && r.tenant?.id === tenantId,
    );
    if (found) return found.id;

    try {
      const created = await this.roles.create(
        {
          name: 'AI Assistant',
          slug: BOT_ROLE_SLUG,
          description:
            'System role for the AI bot actor — booking-only, least privilege.',
          permissionSlugs: AI_BOT_PERMISSIONS,
        },
        tenantId,
        // FND-009's privilege-escalation guard rejects any slug the CALLER does
        // not hold, and this argument defaulted to `[]` — so provisioning could
        // never succeed ("You cannot grant a permission you do not hold: ...").
        // The bot role could only be used where it already existed, which is why
        // this never surfaced on a database that had one.
        //
        // This is trusted server-side provisioning of a FIXED, code-defined,
        // least-privilege role — not a user delegating their own rights — so the
        // authorising set is exactly the constant being granted. Passing the
        // same constant keeps the guard fully in force for real callers (HTTP
        // `POST /roles` still passes the authenticated caller's permissions)
        // while allowing the system to create its own role. Widening
        // AI_BOT_PERMISSIONS therefore stays a deliberate, reviewable code
        // change rather than something a request can influence.
        AI_BOT_PERMISSIONS,
      );
      return created.id;
    } catch (err) {
      // Race: another inbound message created it first — reload and use it.
      if (
        err instanceof AppError &&
        err.code === ErrorCode.ROLE_ALREADY_EXISTS
      ) {
        const reloaded = await this.roles.findAll(tenantId);
        const race = reloaded.find(
          (r) => r.slug === BOT_ROLE_SLUG && r.tenant?.id === tenantId,
        );
        if (race) return race.id;
      }
      throw err;
    }
  }

  private async ensureAssignment(
    userId: string,
    roleId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      await this.roles.assignRoleToUser(userId, roleId, tenantId);
    } catch (err) {
      if (
        err instanceof AppError &&
        err.code === ErrorCode.ROLE_ASSIGNMENT_EXISTS
      )
        return;
      throw err;
    }
  }
}

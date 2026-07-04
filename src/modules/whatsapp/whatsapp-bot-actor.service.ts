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

/** Fixed, per-tenant-unique identity for the bot (users.email is unique PER TENANT). */
const BOT_EMAIL = 'ai-bot@bot.internal';
const BOT_ROLE_SLUG = ROLE.AI_BOT;

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
  private readonly cache = new Map<string, AuthenticatedUser>();

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly roles: RolesService,
    private readonly auth: AuthService,
  ) {}

  /** Find-or-create the tenant's bot user + role + assignment; cached per tenant. */
  async ensureBotActor(tenantId: string): Promise<AuthenticatedUser> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    const userId = await this.ensureBotUser(tenantId);
    const roleId = await this.ensureBotRole(tenantId);
    await this.ensureAssignment(userId, roleId, tenantId);

    // Reuse the EXACT same live roles/permissions lookup the REST JwtStrategy
    // and WsAuthService use — no second principal-building path.
    const principal = await this.auth.buildAuthenticatedUser(userId);
    this.cache.set(tenantId, principal);
    return principal;
  }

  private async ensureBotUser(tenantId: string): Promise<string> {
    const existing = await this.users.findOne({ where: { tenant: { id: tenantId }, email: BOT_EMAIL } });
    if (existing) return existing.id;

    const created = await this.users.save(
      this.users.create({
        tenant: { id: tenantId } as Tenant,
        email: BOT_EMAIL,
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
    const found = existing.find((r) => r.slug === BOT_ROLE_SLUG && r.tenant?.id === tenantId);
    if (found) return found.id;

    try {
      const created = await this.roles.create(
        {
          name: 'AI Assistant',
          slug: BOT_ROLE_SLUG,
          description: 'System role for the AI bot actor — booking-only, least privilege.',
          permissionSlugs: AI_BOT_PERMISSIONS,
        },
        tenantId,
      );
      return created.id;
    } catch (err) {
      // Race: another inbound message created it first — reload and use it.
      if (err instanceof AppError && err.code === ErrorCode.ROLE_ALREADY_EXISTS) {
        const reloaded = await this.roles.findAll(tenantId);
        const race = reloaded.find((r) => r.slug === BOT_ROLE_SLUG && r.tenant?.id === tenantId);
        if (race) return race.id;
      }
      throw err;
    }
  }

  private async ensureAssignment(userId: string, roleId: string, tenantId: string): Promise<void> {
    try {
      await this.roles.assignRoleToUser(userId, roleId, tenantId);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.ROLE_ASSIGNMENT_EXISTS) return;
      throw err;
    }
  }
}

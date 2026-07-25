import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../../../entities/Auth&RBAC/User';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { isUniqueViolation } from '../../../common/errors';

/**
 * The tenant's INTEGRATION SERVICE ACCOUNT (Phase 4).
 *
 * Appointments record real ownership — `booked_by`, `cancelled_by` and
 * `rescheduled_by` are foreign keys to `users`. A machine-originated write (M2M
 * API key, queue worker, inbound webhook) has no human behind it, and the two
 * tempting shortcuts are both wrong:
 *
 *   - passing the API-key principal id (`apikey:<uuid>`) would either violate the
 *     FK or, worse, collide with a real user id, and
 *   - nulling the column would erase attribution for every integration-created
 *     booking, making the audit trail useless exactly where it matters most.
 *
 * So each tenant gets ONE real, verified `users` row that represents "this
 * clinic's integrations". It is a first-class FK target, it is instantly
 * recognisable in the audit trail, and it is deliberately unable to act as a
 * person:
 *
 *   - `password_hash` is NULL — credential login skips accounts without a hash,
 *   - `is_active` is FALSE — every auth path rejects an inactive user, so even a
 *     forged/leaked token for it is useless,
 *   - it is granted NO roles, so it holds no permission whatsoever, and
 *   - its address is on the reserved `.invalid` TLD, so no password-reset mail
 *     can ever be delivered to it.
 *
 * It is therefore an ATTRIBUTION identity, never an authentication one. This is
 * not a second authentication flow: nothing here issues, accepts or validates a
 * credential.
 *
 * Creation is idempotent under concurrency: the `(tenant, email)` unique
 * constraint is the real guarantee, and a lost insert race re-reads the winner.
 */
@Injectable()
export class IntegrationServiceAccountService {
  private readonly logger = new Logger(IntegrationServiceAccountService.name);

  /** Cache tenant → user id; the row is immutable once created. */
  private readonly cache = new Map<string, string>();

  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  /** Deterministic, non-deliverable address (reserved TLD, RFC 6761). */
  static emailFor(tenantId: string): string {
    return `integrations+${tenantId}@service.invalid`;
  }

  /**
   * The tenant's integration service-account user id, creating it on first use.
   * Safe to call on every machine-originated write.
   */
  async resolve(tenantId: string): Promise<string> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    const email = IntegrationServiceAccountService.emailFor(tenantId);
    const existing = await this.users.findOne({
      where: { tenant: { id: tenantId }, email },
      withDeleted: true,
    });
    if (existing) {
      this.cache.set(tenantId, existing.id);
      return existing.id;
    }

    try {
      const created = await this.users.save(
        this.users.create({
          tenant: { id: tenantId } as Tenant,
          email,
          full_name: 'Integrations (service account)',
          // No password_hash, no roles, not active — attribution only.
          is_active: false,
        }),
      );
      this.logger.log(`integration service account created for tenant ${tenantId}`);
      this.cache.set(tenantId, created.id);
      return created.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await this.users.findOne({
          where: { tenant: { id: tenantId }, email },
          withDeleted: true,
        });
        if (winner) {
          this.cache.set(tenantId, winner.id);
          return winner.id;
        }
      }
      throw err;
    }
  }

  /**
   * Resolve the actor to attribute a write to: a real signed-in user when there
   * is one, otherwise the tenant's service account. Never invents an id.
   */
  async resolveActorUserId(tenantId: string, userId?: string | null): Promise<string> {
    if (userId && !userId.startsWith('apikey:')) return userId;
    return this.resolve(tenantId);
  }

  /** True when the id is this tenant's service account (for safe view labels). */
  isServiceAccount(tenantId: string, userId: string | null | undefined): boolean {
    if (!userId) return false;
    return this.cache.get(tenantId) === userId;
  }
}

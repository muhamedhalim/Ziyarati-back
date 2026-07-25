import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

/** Integration-platform audit actions (Phase 3). */
export const INTEGRATION_AUDIT_ACTION = {
  CONNECTION_CREATE: 'integration.connection.create',
  CONNECTION_UPDATE: 'integration.connection.update',
  CONNECTION_ACTIVATE: 'integration.connection.activate',
  CONNECTION_DEACTIVATE: 'integration.connection.deactivate',
  CONNECTION_DISCONNECT: 'integration.connection.disconnect',
  CONNECTION_RECONNECT: 'integration.connection.reconnect',
  /** HARD delete — destroys mappings. History survives via SET NULL FKs. */
  CONNECTION_PURGE: 'integration.connection.purge',
  MAPPING_CREATE: 'integration.mapping.create',
  MAPPING_LINK: 'integration.mapping.link',
  MAPPING_UNLINK: 'integration.mapping.unlink',
  MAPPING_RELINK: 'integration.mapping.relink',
  MAPPING_TRANSFER: 'integration.mapping.transfer',
  UPSERT: 'integration.upsert',
  IMPORT: 'integration.import',
  // Inbound webhooks (Phase 4).
  WEBHOOK_ENDPOINT_CREATE: 'integration.webhook.endpoint.create',
  WEBHOOK_ENDPOINT_UPDATE: 'integration.webhook.endpoint.update',
  WEBHOOK_ENDPOINT_DELETE: 'integration.webhook.endpoint.delete',
  WEBHOOK_SECRET_ROTATE: 'integration.webhook.secret.rotate',
  /** An inbound delivery that passed every check and was queued. */
  WEBHOOK_ACCEPTED: 'integration.webhook.accepted',
  /** An inbound delivery refused at the door — reason CODE only, never payload. */
  WEBHOOK_REJECTED: 'integration.webhook.rejected',
  // Staff provisioning review (Phase 4) — every account-linking decision.
  STAFF_PROVISION_APPROVE: 'integration.staff.provision.approve',
  STAFF_PROVISION_REJECT: 'integration.staff.provision.reject',
  STAFF_PROVISION_LINK: 'integration.staff.provision.link',
  // OAuth2/PKCE client (Phase 4) — never a token value in `details`.
  OAUTH_AUTHORIZE: 'integration.oauth.authorize',
  OAUTH_CONNECTED: 'integration.oauth.connected',
  OAUTH_CALLBACK_FAILED: 'integration.oauth.callback.failed',
  OAUTH_REFRESHED: 'integration.oauth.refreshed',
  OAUTH_REFRESH_FAILED: 'integration.oauth.refresh.failed',
  OAUTH_DISCONNECTED: 'integration.oauth.disconnected',
  // Conflict resolution (Phase 4).
  CONFLICT_RESOLVE: 'integration.conflict.resolve',
  /** A resolution refused because the internal record moved on. */
  CONFLICT_STALE: 'integration.conflict.stale',
} as const;

export type IntegrationAuditAction =
  (typeof INTEGRATION_AUDIT_ACTION)[keyof typeof INTEGRATION_AUDIT_ACTION];

/**
 * Records integration-platform lifecycle events to the shared `audit_logs`
 * table (same pattern as ApiKeyAuditService). Best-effort: an audit-write
 * failure never blocks the operation it accompanies. `details` is limited to
 * non-secret metadata — NEVER credentials, tokens, full records, medical notes,
 * or payment details.
 */
@Injectable()
export class IntegrationAuditService {
  private readonly logger = new Logger(IntegrationAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(
    action: IntegrationAuditAction,
    tenantId: string,
    entityType: string,
    entityId: string | undefined,
    actor: { userId?: string; ip?: string },
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
          user: actor.userId ? ({ id: actor.userId } as User) : undefined,
          action,
          entity_type: entityType,
          entity_id: entityId,
          ip_address: actor.ip,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(`integration audit write failed (${action}): ${(err as Error)?.message}`);
    }
  }
}

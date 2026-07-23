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
  MAPPING_CREATE: 'integration.mapping.create',
  MAPPING_LINK: 'integration.mapping.link',
  UPSERT: 'integration.upsert',
  IMPORT: 'integration.import',
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

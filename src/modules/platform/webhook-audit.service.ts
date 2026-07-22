import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

export const WEBHOOK_AUDIT_ACTION = {
  CREATE: 'webhook.create',
  UPDATE: 'webhook.update',
  ROTATE_SECRET: 'webhook.rotate_secret',
  ENABLE: 'webhook.enable',
  DISABLE: 'webhook.disable',
  DELETE: 'webhook.delete',
  REPLAY: 'webhook.replay',
  RETRY: 'webhook.retry',
} as const;

export type WebhookAuditAction = (typeof WEBHOOK_AUDIT_ACTION)[keyof typeof WEBHOOK_AUDIT_ACTION];

/**
 * Records outbound-webhook lifecycle events to the shared `audit_logs` table
 * (entity_type `WebhookEndpoint` or `WebhookDelivery`), mirroring
 * ApiKeyAuditService's pattern exactly. Best-effort: a logging failure never
 * blocks the operation it accompanies. NEVER pass the plaintext secret —
 * `details` is limited to non-secret metadata (name, events, url host).
 */
@Injectable()
export class WebhookAuditService {
  private readonly logger = new Logger(WebhookAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(
    action: WebhookAuditAction,
    tenantId: string,
    userId: string | undefined,
    entityType: 'WebhookEndpoint' | 'WebhookDelivery',
    entityId: string,
    ip: string | undefined,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
          user: userId ? ({ id: userId } as User) : undefined,
          action,
          entity_type: entityType,
          entity_id: entityId,
          ip_address: ip,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(`Webhook audit write failed (${action}): ${(err as Error)?.message}`);
    }
  }
}

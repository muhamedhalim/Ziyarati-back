import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { LOG_EVENT } from '../../common/logging/log-events';

export const API_KEY_AUDIT_ACTION = {
  CREATE: 'api_key.create',
  ROTATE: 'api_key.rotate',
  REVOKE: 'api_key.revoke',
  ACTIVATE: 'api_key.activate',
  DEACTIVATE: 'api_key.deactivate',
} as const;

export type ApiKeyAuditAction =
  (typeof API_KEY_AUDIT_ACTION)[keyof typeof API_KEY_AUDIT_ACTION];

/**
 * Records API-key lifecycle events to the shared `audit_logs` table
 * (entity_type `ApiKey`), mirroring FinancialAuditService's pattern.
 * Best-effort: a logging failure never blocks the key operation it
 * accompanies. NEVER pass the plaintext key or any header/credential value —
 * `details` is limited to non-secret metadata (name, scope list, expiry).
 */
@Injectable()
export class ApiKeyAuditService {
  private readonly logger = new Logger(ApiKeyAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  /**
   * `tenantId` is `null` only for a platform-level key (contract C11 — no
   * tenant owns it). `AuditLog.tenant` is itself nullable for exactly this
   * case.
   */
  async record(
    action: ApiKeyAuditAction,
    tenantId: string | null,
    userId: string | undefined,
    keyId: string,
    ip: string | undefined,
    details?: Record<string, unknown>,
  ): Promise<void> {
    // Operational breadcrumb alongside the durable audit row (LOGGING.md).
    // Ids and the action only — never the key value or its prefix/details.
    this.logger.log({
      event: LOG_EVENT.AUTH_API_KEY_CHANGED,
      message: `API key ${action}`,
      action,
      api_key_id: keyId,
      tenant_id: tenantId ?? undefined,
      user_id: userId,
    });
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: tenantId ? ({ id: tenantId } as Tenant) : undefined,
          user: userId ? ({ id: userId } as User) : undefined,
          action,
          entity_type: 'ApiKey',
          entity_id: keyId,
          ip_address: ip,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(`API key audit write failed (${action}): ${(err as Error)?.message}`);
    }
  }
}

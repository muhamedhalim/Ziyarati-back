import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

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

  async record(
    action: ApiKeyAuditAction,
    tenantId: string,
    userId: string | undefined,
    keyId: string,
    ip: string | undefined,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
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

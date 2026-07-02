import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';

export const USAGE_AUDIT_ACTION = {
  VIEW: 'PLATFORM_USAGE_VIEW',
  EXPORT: 'PLATFORM_USAGE_EXPORT',
} as const;

/**
 * Records super-admin platform-usage actions to the shared `audit_logs` table
 * (entity_type `platform_usage`). Best-effort: a logging failure never blocks
 * the read it accompanies. Mirrors `FinancialAuditService` — same audit trail,
 * different entity_type — rather than introducing a parallel audit store.
 */
@Injectable()
export class UsageAuditService {
  private readonly logger = new Logger(UsageAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(
    action: string,
    userId?: string,
    ip?: string,
    entityId?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          user: userId ? ({ id: userId } as User) : undefined,
          action,
          entity_type: 'platform_usage',
          entity_id: entityId,
          ip_address: ip,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(`Usage audit write failed (${action}): ${(err as Error)?.message}`);
    }
  }
}

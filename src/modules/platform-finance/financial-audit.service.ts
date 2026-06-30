import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';

export const FINANCIAL_AUDIT_ACTION = {
  VIEW: 'FINANCIAL_VIEW',
  EXPORT: 'FINANCIAL_EXPORT',
} as const;

/**
 * Records super-admin financial actions to the shared `audit_logs` table
 * (entity_type `marketplace_finance`). Best-effort: a logging failure never
 * blocks the read it accompanies.
 */
@Injectable()
export class FinancialAuditService {
  private readonly logger = new Logger(FinancialAuditService.name);

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
          entity_type: 'marketplace_finance',
          entity_id: entityId,
          ip_address: ip,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(`Financial audit write failed (${action}): ${(err as Error)?.message}`);
    }
  }
}

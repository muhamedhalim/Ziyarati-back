import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VerificationAuditLog } from '../../entities/SaaS-Core/VerificationAuditLog';

export const VERIFICATION_AUDIT_ACTIONS = [
  'UPLOADED',
  'REPLACED',
  'DELETED',
  'VIEWED',
  'DOWNLOADED',
  'APPROVED',
  'REJECTED',
  'SUBMITTED',
  /** GAP-001 — a review attempt on an already-decided document was refused. */
  'RE_DECISION_REFUSED',
] as const;

export type VerificationAuditAction =
  (typeof VERIFICATION_AUDIT_ACTIONS)[number];

/** Request-derived actor context for an audited action. */
export interface AuditActor {
  id?: string;
  role?: string;
  ip?: string;
  userAgent?: string;
}

export interface RecordAuditInput {
  tenantId: string;
  action: VerificationAuditAction;
  actor?: AuditActor;
  documentId?: string;
  docType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail for verification-document actions. Writes are
 * best-effort: a logging failure must never break the underlying business
 * action, so failures are logged and swallowed.
 */
@Injectable()
export class VerificationAuditService {
  private readonly logger = new Logger(VerificationAuditService.name);

  constructor(
    @InjectRepository(VerificationAuditLog)
    private readonly logs: Repository<VerificationAuditLog>,
  ) {}

  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.logs.save(
        this.logs.create({
          tenant_id: input.tenantId,
          action: input.action,
          document_id: input.documentId,
          doc_type: input.docType,
          actor_id: input.actor?.id,
          actor_role: input.actor?.role,
          ip_address: input.actor?.ip,
          user_agent: input.actor?.userAgent,
          metadata: input.metadata,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to write verification audit (${input.action}, tenant=${input.tenantId}): ${(err as Error)?.message}`,
      );
    }
  }

  /** Most-recent-first audit entries for a tenant (admin review). */
  listForTenant(
    tenantId: string,
    limit = 100,
  ): Promise<VerificationAuditLog[]> {
    return this.logs.find({
      where: { tenant_id: tenantId },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }
}

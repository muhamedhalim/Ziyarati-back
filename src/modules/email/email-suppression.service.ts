import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EmailSuppression } from '../../entities/System/EmailSuppression';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T130/T133/T134/T136).
 *
 * The single read/write seam for `email_suppressions` — every caller
 * (campaign dispatch's consent check, the unsubscribe controller, the bounce/
 * complaint webhook) goes through here, so "suppressed" always means the
 * same thing everywhere and the address is always normalized identically.
 *
 * PER-TENANT, never global (FR-E005/E019's own requirement, restated on the
 * entity): every method takes a tenantId and the UNIQUE (tenant_id, email)
 * constraint enforces it at the database level too.
 */
@Injectable()
export class EmailSuppressionService {
  constructor(
    @InjectRepository(EmailSuppression)
    private readonly suppressions: Repository<EmailSuppression>,
  ) {}

  /** Always lowercase + trim before any read/write — the ONE normalization point. */
  static normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  async isSuppressed(tenantId: string, email: string): Promise<boolean> {
    const row = await this.suppressions.findOne({
      where: {
        tenant: { id: tenantId },
        email: EmailSuppressionService.normalize(email),
      },
    });
    return !!row;
  }

  /**
   * Idempotent (ON CONFLICT DO NOTHING) — a replayed webhook or a double-
   * click unsubscribe is a harmless no-op, never an error or a duplicate row.
   *
   * Deliberately NOT best-effort/swallowed: unlike an audit-log write, this
   * IS the suppression itself — a caller that needs to know it actually took
   * effect (the unsubscribe controller reporting success; a webhook handler
   * deciding whether to let the provider retry) must see a real failure.
   */
  async suppress(
    tenantId: string,
    email: string,
    reason: string,
    source: string,
  ): Promise<void> {
    await this.suppressions
      .createQueryBuilder()
      .insert()
      .into(EmailSuppression)
      .values({
        tenant: { id: tenantId } as Tenant,
        email: EmailSuppressionService.normalize(email),
        reason,
        source,
      })
      .orIgnore()
      .execute();
  }
}

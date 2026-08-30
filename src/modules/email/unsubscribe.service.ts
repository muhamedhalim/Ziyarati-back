import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Customer } from '../../entities/CRM/Customer';

import { UnsubscribeTokenService } from './unsubscribe-token.service';
import { EmailSuppressionService } from './email-suppression.service';
import {
  CampaignAuditService,
  CAMPAIGN_AUDIT_ACTION,
} from '../campaigns/campaign-audit.service';

/** `email_suppressions.reason` value written by this flow — see contracts/public-surfaces.md §D. */
export const UNSUBSCRIBE_REASON = 'UNSUBSCRIBE';
const UNSUBSCRIBE_SOURCE = 'unsubscribe_link';

export interface UnsubscribeView {
  clinicName: string;
  /** Masked (e.g. `pa***@example.com`) — never the raw address (T134's own requirement). */
  email: string;
  alreadyUnsubscribed: boolean;
}

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T134).
 *
 * `contracts/public-surfaces.md` §D. The token identifies a (tenant, email)
 * pair ONLY (see `UnsubscribeTokenService`) — this service never looks up or
 * returns anything beyond the clinic's display name and a masked address.
 *
 * Every method returns `null` for an invalid/unknown token — the controller
 * turns that into the SAME 404 as every other public-surface refusal in this
 * spec, never disclosing which condition applied.
 */
@Injectable()
export class UnsubscribeService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly tokens: UnsubscribeTokenService,
    private readonly suppression: EmailSuppressionService,
    private readonly audit: CampaignAuditService,
  ) {}

  /** No side effect — GET /public/unsubscribe/:token. */
  async resolve(token: string): Promise<UnsubscribeView | null> {
    const target = this.tokens.verify(token);
    if (!target) return null;

    const tenant = await this.tenants.findOne({
      where: { id: target.tenantId },
    });
    if (!tenant) return null;

    const alreadyUnsubscribed = await this.suppression.isSuppressed(
      target.tenantId,
      target.email,
    );
    return {
      clinicName: tenant.name,
      email: this.mask(target.email),
      alreadyUnsubscribed,
    };
  }

  /**
   * POST /public/unsubscribe/:token — idempotent (a second call is a
   * harmless no-op, per `EmailSuppressionService.suppress`'s own guarantee).
   */
  async confirm(token: string): Promise<{ unsubscribed: true } | null> {
    const target = this.tokens.verify(token);
    if (!target) return null;

    const tenant = await this.tenants.findOne({
      where: { id: target.tenantId },
    });
    if (!tenant) return null;

    await this.suppression.suppress(
      target.tenantId,
      target.email,
      UNSUBSCRIBE_REASON,
      UNSUBSCRIBE_SOURCE,
    );

    // Best-effort sync onto the customer record when the address maps to one
    // (FR-E006/E007) — a suppression-list entry is the authoritative gate
    // either way, so a miss here (no matching customer, or a schema hiccup)
    // never leaves the unsubscribe itself incomplete.
    await this.customers
      .createQueryBuilder()
      .update(Customer)
      .set({
        marketing_opt_in: false,
        opted_out_at: () => 'now()',
        opt_out_source: UNSUBSCRIBE_SOURCE,
      })
      .where('"tenantId" = :tenantId', { tenantId: target.tenantId })
      .andWhere('LOWER(email) = :email', { email: target.email })
      .execute();

    // T139 — campaign id/clinic only, never the recipient address.
    await this.audit.record(
      CAMPAIGN_AUDIT_ACTION.UNSUBSCRIBED,
      target.tenantId,
      undefined,
      {
        source: UNSUBSCRIBE_SOURCE,
      },
    );

    return { unsubscribed: true };
  }

  private mask(email: string): string {
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}***@${domain}`;
  }
}

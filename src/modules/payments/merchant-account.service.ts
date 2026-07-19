import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MerchantAccount } from '../../entities/Payments/MerchantAccount';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { PaymentsConfig } from './payments.config';
import {
  MERCHANT_ACCOUNT_STATUS as S,
  MerchantAccountStatusValue,
} from './payments.constants';
import { SubmitMerchantAccountDto } from './dto/submit-merchant-account.dto';
import { ReviewMerchantAccountDto } from './dto/review-merchant-account.dto';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Allowed status transitions, split by WHO may perform them.
 * The clinic can only (re)submit its details; every eligibility decision is a
 * platform-admin action and lands in the row's `status_history` audit trail.
 */
const TENANT_SUBMIT_FROM: MerchantAccountStatusValue[] = [
  S.NOT_STARTED,
  S.PENDING_DOCUMENTS,
  S.REQUIRES_ACTION,
];

const ADMIN_TRANSITIONS: Record<string, MerchantAccountStatusValue[]> = {
  [S.NOT_STARTED]: [S.PENDING_DOCUMENTS],
  [S.PENDING_DOCUMENTS]: [S.UNDER_REVIEW],
  [S.SUBMITTED]: [S.UNDER_REVIEW, S.REQUIRES_ACTION, S.APPROVED, S.REJECTED],
  [S.UNDER_REVIEW]: [S.REQUIRES_ACTION, S.APPROVED, S.REJECTED],
  [S.REQUIRES_ACTION]: [S.UNDER_REVIEW, S.REJECTED],
  [S.APPROVED]: [S.SUSPENDED],
  [S.REJECTED]: [S.UNDER_REVIEW],
  [S.SUSPENDED]: [S.APPROVED],
};

/**
 * Merchant (financial) onboarding for clinics — the marketplace eligibility
 * seam. `merchant_accounts` is tenant-scoped (one row per tenant, unique FK);
 * a missing row is equivalent to NOT_STARTED and is created lazily.
 *
 * Gating rule: when payments are LIVE (production + real gateway), a clinic
 * whose account is not APPROVED cannot create payments or payment links —
 * money must never be collected for a clinic the platform cannot pay out to.
 * In dev/test (Noop flow) the gate is open so the end-to-end flow stays
 * runnable without onboarding fixtures.
 */
@Injectable()
export class MerchantAccountService {
  private readonly logger = new Logger('MerchantAccountService');

  constructor(
    @InjectRepository(MerchantAccount)
    private readonly accounts: Repository<MerchantAccount>,
    private readonly config: PaymentsConfig,
  ) {}

  /** The tenant's account, creating the NOT_STARTED row on first access. */
  async getOrCreate(tenantId: string): Promise<MerchantAccount> {
    const existing = await this.accounts.findOne({
      where: { tenant: { id: tenantId } },
    });
    if (existing) return existing;

    try {
      return await this.accounts.save(
        this.accounts.create({
          tenant: { id: tenantId } as Tenant,
          status: S.NOT_STARTED,
          provider: this.config.providerName,
        }),
      );
    } catch (err) {
      // Lost the unique(tenant) race → another request created it; return it.
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        const raced = await this.accounts.findOne({
          where: { tenant: { id: tenantId } },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  /** Clinic (re)submits its financial details → SUBMITTED. */
  async submit(
    tenantId: string,
    dto: SubmitMerchantAccountDto,
    userId?: string,
  ): Promise<MerchantAccount> {
    const account = await this.getOrCreate(tenantId);
    if (!TENANT_SUBMIT_FROM.includes(account.status as MerchantAccountStatusValue)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Merchant account in status "${account.status}" cannot be submitted`,
      });
    }

    if (dto.bankName !== undefined) account.bank_name = dto.bankName;
    if (dto.beneficiaryName !== undefined) account.beneficiary_name = dto.beneficiaryName;
    if (dto.iban !== undefined) account.iban_masked = this.maskIban(dto.iban);

    this.recordTransition(account, S.SUBMITTED, userId, 'Details submitted by clinic');
    account.submitted_at = new Date();
    return this.accounts.save(account);
  }

  /** Platform-admin review action (status transition and/or recipient id). */
  async review(
    tenantId: string,
    dto: ReviewMerchantAccountDto,
    adminUserId?: string,
  ): Promise<MerchantAccount> {
    const account = await this.getOrCreate(tenantId);

    if (dto.providerRecipientId !== undefined) {
      account.provider_recipient_id = dto.providerRecipientId || undefined;
    }

    if (dto.status && dto.status !== account.status) {
      const allowed = ADMIN_TRANSITIONS[account.status] ?? [];
      if (!allowed.includes(dto.status as MerchantAccountStatusValue)) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Illegal merchant status transition: ${account.status} → ${dto.status}`,
        });
      }
      this.recordTransition(account, dto.status as MerchantAccountStatusValue, adminUserId, dto.note);
      if (dto.status === S.APPROVED) account.approved_at = new Date();
    }
    if (dto.note !== undefined) account.review_notes = dto.note;

    return this.accounts.save(account);
  }

  /** Platform-admin list (all tenants), newest activity first. */
  async listAll(): Promise<MerchantAccount[]> {
    return this.accounts.find({
      relations: { tenant: true },
      order: { updated_at: 'DESC' },
    });
  }

  async getForTenant(tenantId: string): Promise<MerchantAccount> {
    return this.getOrCreate(tenantId);
  }

  /**
   * Marketplace gate: throws unless the clinic may accept LIVE payments.
   * No-op when payments are not live (dev/test Noop flow).
   */
  async assertChargeable(tenantId: string): Promise<void> {
    if (!this.config.paymentsLive) return;
    const account = await this.getOrCreate(tenantId);
    if (account.status !== S.APPROVED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This clinic cannot accept payments yet: its merchant account is not approved. ' +
          `Current onboarding status: ${account.status}.`,
      });
    }
  }

  /**
   * The split-recipient context for a new payment, or null when splits must
   * not be attached (feature disabled, not approved, or no recipient id).
   */
  async splitContext(
    tenantId: string,
  ): Promise<{ recipientId: string } | null> {
    if (!this.config.marketplaceSplitsEnabled) return null;
    const account = await this.getOrCreate(tenantId);
    if (account.status !== S.APPROVED || !account.provider_recipient_id) {
      return null;
    }
    return { recipientId: account.provider_recipient_id };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private recordTransition(
    account: MerchantAccount,
    to: MerchantAccountStatusValue,
    by?: string,
    note?: string,
  ): void {
    const from = account.status;
    account.status = to;
    account.status_history = [
      ...(account.status_history ?? []),
      { from, to, by, at: new Date().toISOString(), ...(note ? { note } : {}) },
    ];
    this.logger.log(`Merchant account ${account.id}: ${from} → ${to}${by ? ` (by ${by})` : ''}`);
  }

  /** Keep only the last 4 characters; never persist the full IBAN. */
  private maskIban(iban: string): string {
    const clean = iban.replace(/\s+/g, '');
    if (clean.length <= 4) return '****';
    return `${clean.slice(0, 2)}** **** ${clean.slice(-4)}`;
  }
}

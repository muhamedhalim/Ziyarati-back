import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MerchantAccount } from '../../entities/Payments/MerchantAccount';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { PaymentsConfig } from './payments.config';
import { OnlinePaymentCapabilityService } from './online-payment-capability.service';
import {
  MERCHANT_ACCOUNT_STATUS as S,
  MerchantAccountStatusValue,
  ONLINE_PAYMENT_UNAVAILABLE,
  TAP_ONBOARDING_CLAIM_STALE_MS,
  isProviderMerchantId,
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
    private readonly capability: OnlinePaymentCapabilityService,
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
      const next = dto.providerRecipientId.trim() || undefined;
      // The id is interpolated into charge requests and logs: refuse anything
      // that is not a plain provider token rather than store it.
      if (next !== undefined && !isProviderMerchantId(next)) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'The merchant id is not in a recognised format',
        });
      }
      if (next !== account.provider_recipient_id) {
        // Changing WHERE a clinic's money is routed is attributable even when it
        // does not coincide with a status change. The ids themselves are opaque
        // references, not secrets, so the trail records both ends.
        this.recordNote(
          account,
          adminUserId,
          `Merchant id changed: ${account.provider_recipient_id ?? '(none)'} → ${next ?? '(none)'}`,
        );
        account.provider_recipient_id = next;
      }
    }

    if (dto.status && dto.status !== account.status) {
      const allowed = ADMIN_TRANSITIONS[account.status] ?? [];
      if (!allowed.includes(dto.status as MerchantAccountStatusValue)) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Illegal merchant status transition: ${account.status} → ${dto.status}`,
        });
      }
      if (
        dto.status === S.APPROVED &&
        account.provider === 'tap' &&
        !account.provider_recipient_id
      ) {
        // An approved Tap clinic with no merchant would pass every gate and then
        // have nowhere to settle: refuse, so "approved" always means chargeable.
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'Set the clinic’s Tap merchant id (providerRecipientId) before approving it',
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
   * The clinic's own view: the account plus what online payment can currently do
   * for it. `onboardingAvailable` is deliberately NOT gated on
   * `TAP_BOOKING_PAYMENTS_ENABLED` — clinics are onboarded BEFORE that flag is
   * turned on; only taking a payment waits for it.
   */
  async getClinicView(tenantId: string) {
    const account = await this.getOrCreate(tenantId);
    const cap = await this.capability.resolve(tenantId);
    return {
      ...account,
      online_payments: {
        provider: this.config.providerName,
        onboarding_available: this.tapOnboardingConfigured(),
        payments_available: cap.available,
        ...(cap.reason ? { reason: cap.reason } : {}),
      },
    };
  }

  /** TRUE when this deployment can start Tap Lead/Connect onboarding. */
  tapOnboardingConfigured(): boolean {
    return (
      this.capability.tapGoverned &&
      !!this.config.tapPlatformId &&
      !!this.config.tapOnboardingSecretKey &&
      !!this.config.tapWebhookUrl
    );
  }

  /**
   * Marketplace gate: throws unless the clinic may accept payments.
   *
   * Tap: ALWAYS enforced, in every environment — where a patient's money lands
   * must not depend on NODE_ENV, and a sandbox charge still needs a (sandbox)
   * clinic merchant. Noop (dev/test simulator, or payments disabled): open.
   */
  async assertChargeable(tenantId: string): Promise<void> {
    if (this.capability.tapGoverned) {
      const cap = await this.capability.resolve(tenantId);
      if (!cap.available) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            cap.reason === ONLINE_PAYMENT_UNAVAILABLE.CLINIC_NOT_ONBOARDED
              ? 'This clinic cannot accept online payments yet: its Tap merchant account is not approved.'
              : 'Online payments are not enabled yet.',
          publicContext: { reason: cap.reason },
        });
      }
      return;
    }
  }

  /**
   * Where a clinic charge's money goes: the clinic's own Tap merchant. `null`
   * for a provider that does not route by merchant (the caller then sends no
   * routing at all). Always consult `assertChargeable` first — this never throws.
   */
  async routingContext(
    tenantId: string,
  ): Promise<{ settlementMerchantId: string } | null> {
    const cap = await this.capability.resolve(tenantId);
    return cap.available && cap.settlementMerchantId
      ? { settlementMerchantId: cap.settlementMerchantId }
      : null;
  }

  // ───────────────────────── Tap onboarding (state only) ─────────────────────── //
  //
  // The HTTP half (Lead + Connect) lives in `TapOnboardingService`; everything
  // that touches the account row's state machine stays here, so there is one
  // place that decides which status an account may be in and records why.

  /**
   * Atomically claim the right to run Tap onboarding for this clinic. Two
   * concurrent "connect" clicks must create ONE lead (Tap has no idempotency
   * key for leads, and each lead must be a unique legal entity), so this is a
   * conditional UPDATE: it succeeds for exactly one caller, and a claim older
   * than `TAP_ONBOARDING_CLAIM_STALE_MS` (its owner died) can be taken over.
   * Returns false when someone else holds a fresh claim.
   */
  async claimTapOnboarding(accountId: string): Promise<boolean> {
    const stale = new Date(Date.now() - TAP_ONBOARDING_CLAIM_STALE_MS);
    const res = await this.accounts
      .createQueryBuilder()
      .update(MerchantAccount)
      .set({ provider_onboarding_claimed_at: () => 'now()' })
      .where('id = :id', { id: accountId })
      .andWhere(
        '(provider_onboarding_claimed_at IS NULL OR provider_onboarding_claimed_at < :stale)',
        { stale },
      )
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /** Release the claim without a result (the Tap call failed; a retry may proceed). */
  async releaseTapOnboardingClaim(accountId: string): Promise<void> {
    await this.accounts.update(accountId, {
      provider_onboarding_claimed_at: null,
    });
  }

  /**
   * The Tap lead now exists: this account belongs to Tap from here on.
   *
   * Switching an account that previously belonged to another provider does NOT
   * carry that provider's approval or recipient id across — an approval under
   * another provider says nothing about a Tap merchant. The old recipient id is copied
   * into the audit trail before it is cleared, so nothing is lost, and the
   * status goes back to NOT_STARTED so a retry (should the Connect call that
   * follows fail) is allowed to proceed.
   */
  async recordTapLeadCreated(
    account: MerchantAccount,
    leadId: string,
    userId?: string,
  ): Promise<MerchantAccount> {
    if (account.provider !== 'tap') {
      if (account.provider_recipient_id) {
        this.recordNote(
          account,
          userId,
          `Switched from ${account.provider}: previous recipient id ${account.provider_recipient_id} retired`,
        );
        account.provider_recipient_id = undefined;
      }
      account.provider = 'tap';
      if (account.status !== S.NOT_STARTED) {
        this.recordTransition(
          account,
          S.NOT_STARTED,
          userId,
          'Switched to Tap onboarding',
        );
      }
    }
    account.provider_lead_id = leadId;
    return this.accounts.save(account);
  }

  /**
   * The clinic has a Connect URL and is now filling in Tap's own form. Stores
   * the callback token's HASH, clears the claim and moves the account to
   * PENDING_DOCUMENTS (a re-issued link for a clinic already there just leaves
   * a note and replaces the token).
   */
  async recordTapOnboardingStarted(
    account: MerchantAccount,
    input: { leadId: string; callbackTokenHash: string },
    userId?: string,
  ): Promise<MerchantAccount> {
    account.provider_lead_id = input.leadId;
    account.provider_callback_token_hash = input.callbackTokenHash;
    account.provider_onboarding_claimed_at = null;
    if (account.status === S.PENDING_DOCUMENTS) {
      this.recordNote(account, userId, 'Tap onboarding link issued');
    } else {
      this.recordTransition(
        account,
        S.PENDING_DOCUMENTS,
        userId,
        'Tap onboarding started by clinic',
      );
    }
    return this.accounts.save(account);
  }

  /**
   * Record what Tap told the onboarding callback. ADVISORY ONLY.
   *
   * Tap documents neither the callback's payload nor a signature, so the body
   * is never trusted to decide money routing: this stores an allow-listed CLAIM
   * (never the raw body — a merchant object carries API credentials) and moves a
   * clinic that was filling in Tap's form to UNDER_REVIEW so it shows up for the
   * platform admin. It NEVER sets the recipient id and NEVER approves. A platform
   * admin does that, through `review`, with the claim in front of them.
   *
   * Returns null for an unknown token (the caller answers with the same
   * uniform response either way — no oracle on which tokens exist).
   */
  async recordTapOnboardingClaim(
    callbackTokenHash: string,
    claim: {
      merchantId?: string;
      isAcceptanceAllowed?: boolean;
      isPayoutAllowed?: boolean;
      recognised: boolean;
    },
  ): Promise<MerchantAccount | null> {
    const account = await this.accounts.findOne({
      where: { provider_callback_token_hash: callbackTokenHash },
      relations: { tenant: true },
    });
    if (!account) return null;

    account.provider_capabilities = {
      ...(account.provider_capabilities ?? {}),
      claim: { ...claim, receivedAt: new Date().toISOString() },
    };
    if (account.status === S.PENDING_DOCUMENTS) {
      this.recordTransition(
        account,
        S.UNDER_REVIEW,
        undefined,
        'Tap reported the onboarding form was completed',
      );
    } else {
      this.recordNote(account, undefined, 'Tap onboarding callback received');
    }
    return this.accounts.save(account);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** An audit-trail entry that does not change the status. */
  private recordNote(
    account: MerchantAccount,
    by: string | undefined,
    note: string,
  ): void {
    account.status_history = [
      ...(account.status_history ?? []),
      {
        from: account.status,
        to: account.status,
        by,
        at: new Date().toISOString(),
        note,
      },
    ];
  }

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

import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';

import { MerchantAccountService } from './merchant-account.service';
import { PaymentsConfig } from './payments.config';
import {
  MERCHANT_ACCOUNT_STATUS as S,
  isProviderMerchantId,
} from './payments.constants';
import { TapApiClient } from './providers/tap/tap-api.client';
import { parsePhone, realEmail } from './providers/payer.util';

/** Tap's `brand.name[].text` requires at least 3 characters. */
const MIN_BRAND_TEXT = 3;

/** Statuses a clinic that is already on Tap may (re)start from. */
const STARTABLE_ON_TAP: string[] = [
  S.NOT_STARTED,
  S.PENDING_DOCUMENTS,
  S.REQUIRES_ACTION,
];

const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

export interface TapOnboardingStart {
  /** Tap's hosted onboarding page — send the clinic's browser there. */
  connectUrl: string;
  status: string;
}

/**
 * Tap Platform onboarding for a clinic: Lead → Connect.
 *
 * What the clinic types on Tap's own page (national ID, IBAN, licence…) never
 * touches ZiyaraTech — this service sends only what the platform already holds
 * (clinic name, a contact) and receives a URL. KYC, the national ID Tap requires
 * of Saudi merchants and the IBAN are collected by Tap's hosted Connect board.
 *
 * What is, and is not, documented — and how that shaped this class (Tap docs,
 * checked 2026-10-03):
 *  - `POST /v3/lead` (only `country` is required) and `POST /v3/connect` (returns
 *    `connect.url`; `post.url` and `redirect.url` required) ARE documented. They
 *    are what `start()` calls.
 *  - What Tap POSTS to `post.url` when the clinic finishes, whether it is signed,
 *    and the query string on `redirect.url` are NOT documented, and no endpoint
 *    returns a merchant's `is_acceptance_allowed` for a lead. So the callback is
 *    treated as an UNAUTHENTICATED HINT: `recordCallback()` stores an allow-listed
 *    claim and moves the clinic to UNDER_REVIEW. It never approves a clinic and
 *    never sets where money goes — a platform admin does that, with the claim in
 *    front of them. An unsigned body must not be able to route patient money.
 *
 * Tap's Lead API has no idempotency key and wants one lead per legal entity, so
 * `start()` takes an atomic claim on the account row first and persists the lead
 * id the moment Tap returns it — a retry after a failed Connect call reuses it.
 */
@Injectable()
export class TapOnboardingService {
  private readonly logger = new Logger('TapOnboardingService');

  constructor(
    private readonly merchants: MerchantAccountService,
    private readonly client: TapApiClient,
    private readonly config: PaymentsConfig,
    private readonly dataSource: DataSource,
  ) {}

  async start(
    tenantId: string,
    userId: string | undefined,
    locale?: string,
  ): Promise<TapOnboardingStart> {
    if (!this.merchants.tapOnboardingConfigured()) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Online payment onboarding is not available yet.',
      });
    }

    // Cheap early refusal; authoritative only after the claim below.
    const claimable = await this.merchants.getOrCreate(tenantId);
    this.assertStartable(claimable);

    if (!(await this.merchants.claimTapOnboarding(claimable.id))) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Onboarding is already being started. Try again in a moment.',
      });
    }

    let account = claimable;
    try {
      // Re-read now that this caller holds the claim. A request that read the
      // row before a concurrent start finished, then claimed after that start
      // released it, would otherwise see no lead id and create a SECOND lead
      // (Tap has no idempotency key; one lead per legal entity).
      account = await this.merchants.getOrCreate(tenantId);
      this.assertStartable(account);
      const onTap = account.provider === 'tap';
      let leadId = onTap ? account.provider_lead_id : undefined;
      if (!leadId) {
        leadId = await this.createLead(tenantId, userId);
        // Persist the lead BEFORE the Connect call: if Connect fails, the next
        // attempt reuses this lead instead of creating a duplicate entity.
        await this.merchants.recordTapLeadCreated(account, leadId, userId);
      }

      // A fresh token per Connect session: only its hash is stored, so a lost
      // token cannot be recovered — and a superseded session's callbacks are
      // simply no longer accepted.
      const token = randomBytes(32).toString('base64url');
      const connectUrl = await this.createConnect(leadId, token, locale);

      const saved = await this.merchants.recordTapOnboardingStarted(
        account,
        { leadId, callbackTokenHash: sha256(token) },
        userId,
      );
      return { connectUrl, status: saved.status };
    } catch (err) {
      // The claim is released on every failure path so the clinic can retry at
      // once; on success `recordTapOnboardingStarted` already cleared it.
      await this.merchants
        .releaseTapOnboardingClaim(account.id)
        .catch(() => undefined);
      throw err;
    }
  }

  private assertStartable(account: { provider: string; status: string }): void {
    if (
      account.provider === 'tap' &&
      !STARTABLE_ON_TAP.includes(account.status)
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          account.status === S.APPROVED
            ? 'Online payments are already set up for this clinic.'
            : `Onboarding cannot be started while the account is "${account.status}".`,
      });
    }
  }

  /**
   * The onboarding callback. Always resolves (the route answers 200 whatever
   * the token): a uniform answer leaks nothing about which tokens exist, and
   * Tap should not retry on our account of a stale session. Never logs or stores
   * the body — a Tap merchant object carries the merchant's API credentials.
   */
  async recordCallback(token: string, body: unknown): Promise<void> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      this.logger.warn(
        'Tap onboarding callback with a malformed token — ignored',
      );
      return;
    }
    const account = await this.merchants.recordTapOnboardingClaim(
      sha256(token),
      this.extractClaim(body),
    );
    if (!account) {
      this.logger.warn(
        'Tap onboarding callback for an unknown token — ignored',
      );
      return;
    }
    this.logger.log(
      `Tap onboarding callback recorded for merchant account ${account.id} (status ${account.status})`,
    );
  }

  // ─────────────────────────────── Tap calls ─────────────────────────────── //

  private async createLead(
    tenantId: string,
    userId: string | undefined,
  ): Promise<string> {
    const tenant = await this.dataSource
      .getRepository(Tenant)
      .findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Clinic not found' });
    }
    const user = userId
      ? await this.dataSource
          .getRepository(User)
          .findOne({ where: { id: userId } })
      : null;

    const res = await this.client.createLead(this.leadBody(tenant, user));
    if (!res.ok || !res.json?.id) {
      this.failed('lead', res);
    }
    return res.json.id;
  }

  private async createConnect(
    leadId: string,
    token: string,
    locale?: string,
  ): Promise<string> {
    const postUrl = this.config.tapOnboardingCallbackUrl(token);
    if (!postUrl) {
      // `TAP_WEBHOOK_URL` unset — start() checks this first, so this is a guard.
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Online payment onboarding is not available yet.',
      });
    }
    const res = await this.client.createConnect({
      scope: 'merchant',
      lead: { id: leadId },
      redirect: { url: this.config.tapOnboardingReturnUrl() },
      post: { url: postUrl },
      board: { editable: true, display: true },
      interface: {
        locale: locale === 'ar' ? 'ar' : 'en',
        direction: locale === 'ar' ? 'rtl' : 'ltr',
      },
    });
    const url = res.json?.connect?.url;
    if (!res.ok || !isHttpsUrl(url)) {
      this.failed('connect', res);
    }
    return url as string;
  }

  /**
   * Only documented fields, and only what the platform already knows. Anything
   * personal beyond a contact (national ID, birth date, IBAN, licence) is left
   * for the clinic to enter on Tap's own page.
   */
  private leadBody(tenant: Tenant, user: User | null): Record<string, unknown> {
    const pad = (name: string) =>
      name.length >= MIN_BRAND_TEXT ? name : `${name} Clinic`;
    const brand = pad((tenant.name ?? '').trim() || 'Clinic');
    const legal = pad((tenant.legal_name ?? tenant.name ?? '').trim() || brand);

    const email = realEmail(tenant.contact_email) ?? realEmail(user?.email);
    const phone = parsePhone(tenant.contact_phone) ?? parsePhone(user?.phone);
    const names = String(user?.full_name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const contactUser: Record<string, unknown> = { primary: true };
    if (names.length) {
      contactUser.name = [
        {
          lang: 'en',
          first: names[0],
          ...(names.length > 1 ? { last: names.slice(1).join(' ') } : {}),
        },
      ];
    }
    const contact: Record<string, unknown> = {};
    if (email) contact.email = [{ address: email, primary: true }];
    if (phone) {
      contact.phone = [
        {
          country_code: phone.countryCode,
          number: phone.number,
          primary: true,
        },
      ];
    }
    if (Object.keys(contact).length) contactUser.contact = contact;

    return {
      country: 'SA',
      brand: { name: [{ lang: 'en', text: brand }] },
      entity: { legal_name: [{ lang: 'en', text: legal }] },
      wallet: { currency: 'SAR', country: 'SA' },
      // Ties the new merchant to OUR platform, which is what lets us charge on
      // its behalf (`merchant.id` + `platform.id`).
      merchant: { platforms: [{ id: this.config.tapPlatformId }] },
      ...(Object.keys(contactUser).length > 1 ? { users: [contactUser] } : {}),
    };
  }

  private failed(
    step: 'lead' | 'connect',
    res: { status: number; transient: boolean; errorCode?: string },
  ): never {
    this.logger.warn(
      `Tap ${step} request failed (http ${res.status}, code ${res.errorCode ?? 'n/a'})`,
    );
    if (res.transient) {
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        message:
          'The payment provider is temporarily unavailable. Try again shortly.',
      });
    }
    // Never forward Tap's wording: it can name fields the clinic cannot act on.
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message:
        'We could not start online payment onboarding. Please contact support.',
    });
  }

  /**
   * Reduce an UNTRUSTED callback body to the few advisory facts we keep. Tap
   * documents the merchant object a finished onboarding yields (`id:
   * merchant_…`, `is_acceptance_allowed`, `is_payout_allowed`), but not that it
   * is what is posted — so a body in any other shape is simply "unrecognised".
   */
  private extractClaim(body: unknown): {
    merchantId?: string;
    isAcceptanceAllowed?: boolean;
    isPayoutAllowed?: boolean;
    recognised: boolean;
  } {
    const root = isRecord(body) ? body : {};
    const merchant = isRecord(root.merchant)
      ? root.merchant
      : root.object === 'merchant'
        ? root
        : undefined;
    const id = merchant?.id;
    const merchantId = isProviderMerchantId(id) ? id : undefined;
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    return {
      merchantId,
      isAcceptanceAllowed: flag(merchant?.is_acceptance_allowed),
      isPayoutAllowed: flag(merchant?.is_payout_allowed),
      recognised: merchantId !== undefined,
    };
  }
}

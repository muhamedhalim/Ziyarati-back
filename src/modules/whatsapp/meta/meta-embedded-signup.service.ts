import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { Branch } from '../../../entities/SaaS-Core/Branch';
import { AppError, ErrorCode } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';

import { MetaConfig } from './meta.config';
import { MetaGraphClient } from './meta-graph.client';
import { CompleteEmbeddedSignupDto } from '../dto/complete-embedded-signup.dto';
import {
  COEXISTENCE_SYNC_STATUS,
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_CONNECTION_STATUS,
  WHATSAPP_ONBOARDING_TYPE,
  WHATSAPP_PROVIDER,
} from '../whatsapp.constants';
import { QueueService } from '../../../queue/queue.service';

/**
 * Scopes the Embedded Signup flow must have granted. If Meta hands back a token
 * without these, the connection would appear to succeed and then fail on the
 * first send — better to reject it during onboarding while the user is still
 * looking at the screen.
 */
const REQUIRED_SCOPES = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
];

/**
 * Meta Embedded Signup — the onboarding flow that makes ZiyaraTech an
 * Independent Tech Provider.
 *
 * The browser opens Meta's dialog with our APP ID + CONFIG ID (the only Meta
 * values it ever sees), the clinic picks/creates its own Meta Business, WABA and
 * phone number, and Meta hands the browser a SHORT-LIVED authorization code.
 * That code is all the frontend posts back here. Everything that follows —
 * exchanging it for a real token, validating it, subscribing the webhook,
 * storing the credential — happens server-side, which is precisely why the
 * frontend can never hold a permanent Meta access token.
 *
 * Order matters and each step is a gate:
 *   1. exchange code → token            (needs the app secret; server-only)
 *   2. debug_token                      (proves the token was minted for OUR
 *                                        app, not replayed from another — the
 *                                        step that stops WABA-injection)
 *   3. read the WABA + phone number     (proves the token really controls what
 *                                        the client claims it does; we never
 *                                        trust the ids from the request body)
 *   4. subscribe the WABA to our webhook (without it, no inbound events ever
 *                                        arrive — onboarding is incomplete)
 *   5. persist, encrypted, under the AUTHENTICATED tenant
 *
 * Tenant isolation: the tenantId comes from TenantContextService via the
 * controller — never from the request. A phone number already connected to
 * another tenant is rejected (409), and the DB's partial unique index backstops
 * the race.
 */
@Injectable()
export class MetaEmbeddedSignupService {
  private readonly logger = new Logger('MetaEmbeddedSignupService');

  constructor(
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    private readonly graph: MetaGraphClient,
    private readonly config: MetaConfig,
    private readonly encryption: EncryptionService,
    private readonly queue: QueueService,
  ) {}

  /**
   * The public identifiers the frontend needs to launch the dialog. Returns
   * ONLY appId/configId/graphVersion — never the app secret.
   */
  publicConfig() {
    return this.config.requirePublicConfig();
  }

  /**
   * Lightweight, always-200 status check for the frontend to gate the Connect
   * button WITHOUT treating "not configured yet" as an error to retry.
   * `publicConfig()` above throws 422 when incomplete (correct for the
   * onboarding dialog itself, which genuinely cannot proceed); this exists
   * because a boolean is a cleaner signal for a UI decision than parsing an
   * error response. Never returns a secret — `embeddedSignupConfigured` is a
   * derived boolean, not a value.
   */
  status(): { configured: boolean } {
    return { configured: this.config.embeddedSignupConfigured };
  }

  /**
   * Completes onboarding for the authenticated tenant and returns the connected
   * account (safe view — no token).
   */
  async complete(
    tenantId: string,
    dto: CompleteEmbeddedSignupDto,
  ): Promise<WhatsappAccount> {
    // Fail before touching Meta if the branch is bogus — a cheap, tenant-scoped
    // check that also stops branch-id probing across tenants.
    if (dto.branchId) await this.assertBranch(tenantId, dto.branchId);

    this.stage(tenantId, 'META_EMBEDDED_SIGNUP_CALLBACK_RECEIVED');

    // ── 1. Code → token (server-side only; requires the app secret) ────────
    const exchanged = await this.trace(
      tenantId,
      'META_OAUTH_CODE_EXCHANGE',
      () => this.graph.exchangeCode(dto.code),
    );

    // ── 2. Prove the token belongs to OUR app and can do what we need ──────
    const debug = await this.trace(tenantId, 'META_TOKEN_INTROSPECTION', () =>
      this.graph.debugToken(exchanged.accessToken),
    );
    this.assertTokenTrustworthy(debug);

    // ── 3. Prove the token actually controls the claimed WABA + number ─────
    // The ids arrive from the browser, so they are untrusted input: we re-read
    // both from Meta with the token itself. A caller who posts someone else's
    // wabaId gets a Graph failure here rather than a hijacked connection.
    const waba = await this.trace(tenantId, 'META_WABA_LOOKUP', () =>
      this.graph.getWaba(dto.wabaId, exchanged.accessToken),
    );
    const phone = await this.trace(tenantId, 'META_PHONE_NUMBER_LOOKUP', () =>
      this.resolvePhoneNumber(
        dto.wabaId,
        dto.phoneNumberId,
        exchanged.accessToken,
      ),
    );

    // Reject a number already held by ANOTHER tenant before we subscribe the
    // webhook — otherwise we'd start routing its events with nowhere to put them.
    await this.assertPhoneNumberAvailable(tenantId, phone.id);

    // ── 4. Route this WABA's events to the platform webhook ───────────────
    await this.trace(tenantId, 'META_WEBHOOK_SUBSCRIPTION', () =>
      this.graph.subscribeAppToWaba(waba.id, exchanged.accessToken),
    );

    // ── 5. Persist under the authenticated tenant, encrypted ──────────────
    const onboardingType =
      dto.onboardingType ?? WHATSAPP_ONBOARDING_TYPE.STANDARD;
    const account = await this.persist(
      tenantId,
      dto,
      exchanged,
      debug,
      waba,
      phone,
      onboardingType,
    );

    this.stage(tenantId, 'META_WHATSAPP_CONNECTION_SAVED');
    this.logger.log(
      `Tenant ${tenantId} connected WhatsApp number ${phone.id} (waba=${waba.id}) via Embedded Signup ` +
        `(onboardingType=${onboardingType})`,
    );

    // ── 6. Coexistence only ─────────────────────────────────────────────
    // The number is already registered/usable in the clinic's own WhatsApp
    // Business App. There is deliberately NO phone-number registration call
    // anywhere in this service for EITHER onboarding type today — this stage
    // marker exists so that guarantee is explicit, logged and testable for
    // Coexistence specifically, rather than an accidental absence that a
    // future STANDARD-flow change could silently start applying here too.
    if (onboardingType === WHATSAPP_ONBOARDING_TYPE.COEXISTENCE) {
      this.stage(
        tenantId,
        'META_COEXISTENCE_PHONE_REGISTRATION_SKIPPED',
        `phone=${phone.id}`,
      );
      await this.verifyCoexistenceStatus(
        tenantId,
        account.id,
        phone.id,
        exchanged.accessToken,
      );
      await this.kickOffCoexistenceSync(tenantId, account.id);
    }

    return account;
  }

  /**
   * Post-onboarding verification gate — Embedded Signup completing without a
   * frontend error is NOT proof Coexistence actually took effect. Reads
   * Meta's own `is_on_biz_app`/`platform_type` for the number and records it
   * on the account either way.
   *
   * Best-effort by design: Meta's state can lag briefly behind the dialog
   * closing, so a mismatch is logged loudly (and visible via
   * `WhatsappAccountService.connectionStatus`) rather than treated as a
   * reason to undo an otherwise-valid connection — the credential, WABA and
   * webhook subscription from steps 1-4 are already correct.
   */
  private async verifyCoexistenceStatus(
    tenantId: string,
    accountId: string,
    phoneNumberId: string,
    token: string,
  ): Promise<void> {
    try {
      const status = await this.trace(
        tenantId,
        'META_COEXISTENCE_STATUS_VERIFICATION',
        () => this.graph.getPhoneCoexistenceStatus(phoneNumberId, token),
      );
      const verified =
        status.isOnBizApp === true && status.platformType === 'CLOUD_API';
      if (verified) {
        this.stage(
          tenantId,
          'META_COEXISTENCE_VERIFIED',
          `phone=${phoneNumberId}`,
        );
      } else {
        this.logger.warn(
          `META_COEXISTENCE_VERIFICATION_MISMATCH tenant=${tenantId} phone=${phoneNumberId} ` +
            `isOnBizApp=${status.isOnBizApp ?? 'unknown'} platformType=${status.platformType ?? 'unknown'} — ` +
            'Meta has not confirmed Coexistence yet; the connection is kept, this is reported, not fatal.',
        );
      }
      await this.accounts.update(accountId, {
        is_on_biz_app: status.isOnBizApp ?? null,
        platform_type: status.platformType ?? null,
      });
    } catch (err) {
      // Never aborts onboarding over a verification READ failing — see docblock.
      this.logger.error(
        `META_COEXISTENCE_VERIFICATION_FAILED tenant=${tenantId} phone=${phoneNumberId}: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Kicks off the state-sync → history sync pair on the background queue
   * (WhatsappCoexistenceSyncService owns the ordering/idempotency). Best-effort:
   * a failed enqueue must not undo a valid connection, mirroring the template
   * sync call in WhatsappOnboardingController#complete.
   */
  private async kickOffCoexistenceSync(
    tenantId: string,
    accountId: string,
  ): Promise<void> {
    try {
      await this.accounts.update(accountId, {
        coexistence_state_sync_status: COEXISTENCE_SYNC_STATUS.PENDING,
        coexistence_history_sync_status: COEXISTENCE_SYNC_STATUS.PENDING,
      });
      await this.queue.enqueueWhatsappCoexistenceSync({ tenantId, accountId });
    } catch (err) {
      this.logger.error(
        `META_COEXISTENCE_SYNC_ENQUEUE_FAILED tenant=${tenantId} account=${accountId}: ${(err as Error)?.message}`,
      );
    }
  }

  // ─────────────────────────── Stage diagnostics ─────────────────────────── //

  /**
   * Onboarding crosses five Meta round-trips, and until now a failure in any of
   * them surfaced as one indistinguishable 422 — which is exactly why a broken
   * WABA read went undiagnosed. These markers name the stage that failed.
   *
   * NEVER logged: the authorization code, the access token, the app secret. The
   * tenant id and Meta's own error code/type are the whole payload; Meta's
   * code/subcode is already recorded by MetaGraphClient.request().
   */
  private stage(tenantId: string, marker: string, detail?: string): void {
    this.logger.log(
      `${marker} tenant=${tenantId}${detail ? ` ${detail}` : ''}`,
    );
  }

  /** Runs one stage, emitting a `_STARTED` marker and a `_FAILED` one on throw. */
  private async trace<T>(
    tenantId: string,
    marker: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.stage(tenantId, `${marker}_STARTED`);
    try {
      return await run();
    } catch (err) {
      // `AppError.message` here is Meta's own rejection text, already stripped
      // of credentials by the client. Anything else is logged by type only.
      const reason =
        err instanceof AppError
          ? err.message
          : ((err as Error)?.name ?? 'unknown');
      this.logger.error(`${marker}_FAILED tenant=${tenantId} reason=${reason}`);
      throw err;
    }
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /**
   * The security gate of the whole flow. A token that is valid but was issued
   * for a DIFFERENT app means someone is replaying a token from an app they
   * control — accepting it would attach their WABA to this tenant.
   */
  private assertTokenTrustworthy(debug: {
    appId: string;
    isValid: boolean;
    scopes: string[];
  }): void {
    if (!debug.isValid) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Meta reported this authorization as invalid. Please retry the connection.',
      });
    }

    if (debug.appId !== this.config.requireAppId()) {
      // Do not echo the foreign app id back to the caller.
      this.logger.error(
        'Embedded Signup rejected: token was issued for a different Meta app (possible replay).',
      );
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'This authorization was not issued for this platform.',
      });
    }

    const missing = REQUIRED_SCOPES.filter((s) => !debug.scopes.includes(s));
    if (missing.length > 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'The WhatsApp connection did not grant the permissions required to send and manage messages. ' +
          'Please redo the connection and accept all requested permissions.',
        publicContext: { missingScopes: missing },
      });
    }
  }

  /**
   * Confirms the phone number exists on the WABA. When the client didn't name
   * one and the WABA has exactly one, we take it — but we never guess between
   * several, because picking the wrong number sends the clinic's messages from
   * the wrong identity.
   */
  private async resolvePhoneNumber(
    wabaId: string,
    requestedPhoneNumberId: string | undefined,
    token: string,
  ) {
    const numbers = await this.graph.listPhoneNumbers(wabaId, token);
    if (numbers.length === 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This WhatsApp Business Account has no phone number yet. Add and verify a number in Meta, then reconnect.',
      });
    }

    if (requestedPhoneNumberId) {
      const match = numbers.find((n) => n.id === requestedPhoneNumberId);
      if (!match) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'The selected phone number does not belong to the connected WhatsApp Business Account.',
        });
      }
      return match;
    }

    if (numbers.length > 1) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This WhatsApp Business Account has multiple phone numbers. Select which number to connect.',
        publicContext: {
          phoneNumbers: numbers.map((n) => ({
            id: n.id,
            displayPhoneNumber: n.displayPhoneNumber,
          })),
        },
      });
    }
    return numbers[0];
  }

  /** @see WhatsappAccountService.assertPhoneNumberUnclaimed — same invariant. */
  private async assertPhoneNumberAvailable(
    tenantId: string,
    phoneNumberId: string,
  ): Promise<void> {
    const existing = await this.accounts.findOne({
      where: { phone_number_id: phoneNumberId, deleted_at: IsNull() },
      relations: { tenant: true },
    });
    if (!existing) return;

    // Same tenant reconnecting the same number is the normal "re-auth" path.
    if (existing.tenant?.id === tenantId) return;

    // Never reveal WHICH tenant holds it — that leaks cross-tenant information.
    this.logger.warn(
      `Tenant ${tenantId} attempted to connect phone_number_id already held by another tenant`,
    );
    throw new AppError(ErrorCode.CONFLICT, {
      message:
        'This WhatsApp phone number is already connected to another account on this platform.',
    });
  }

  /**
   * Upserts the connection. Reconnecting the SAME number updates the existing
   * row (rotating the credential) rather than inserting a duplicate — the
   * partial unique index would reject the insert anyway, and clinics re-run
   * Embedded Signup routinely to refresh an expired token.
   */
  private async persist(
    tenantId: string,
    dto: CompleteEmbeddedSignupDto,
    exchanged: { accessToken: string; expiresInSeconds?: number },
    debug: { expiresAt?: number },
    waba: { id: string; ownerBusinessId?: string },
    phone: { id: string; displayPhoneNumber?: string; verifiedName?: string },
    onboardingType: string,
  ): Promise<WhatsappAccount> {
    const existing = await this.accounts.findOne({
      where: {
        phone_number_id: phone.id,
        tenant: { id: tenantId },
        deleted_at: IsNull(),
      },
    });

    const account =
      existing ?? this.accounts.create({ tenant: { id: tenantId } as Tenant });

    account.provider = WHATSAPP_PROVIDER.META_CLOUD;
    account.mode = WHATSAPP_ACCOUNT_MODE.CUSTOM;
    account.onboarding_type = onboardingType;
    account.meta_business_id = waba.ownerBusinessId ?? dto.metaBusinessId;
    account.waba_id = waba.id;
    account.phone_number_id = phone.id;
    account.display_phone_number = phone.displayPhoneNumber;
    account.verified_name = phone.verifiedName;
    account.access_token = this.encryption.encrypt(exchanged.accessToken);
    account.token_expires_at = this.resolveExpiry(
      exchanged.expiresInSeconds,
      debug.expiresAt,
    );
    account.connection_status = WHATSAPP_CONNECTION_STATUS.CONNECTED;
    account.connected_at = new Date();
    account.is_active = true;
    // `branch = null` ⇒ a tenant-level number usable by every branch.
    account.branch = dto.branchId ? ({ id: dto.branchId } as Branch) : null;

    const saved = await this.accounts.save(account);
    await this.ensureTenantHasDefault(tenantId, saved);
    return saved;
  }

  /**
   * Meta reports expiry two ways and disagrees with itself: `expires_in` from
   * the exchange, `expires_at` from debug_token. Prefer the introspected value
   * (authoritative), fall back to the exchange, and treat absent/0 as
   * "long-lived System User token — does not expire" rather than inventing one.
   */
  private resolveExpiry(
    expiresInSeconds?: number,
    expiresAtUnix?: number,
  ): Date | undefined {
    if (expiresAtUnix && expiresAtUnix > 0)
      return new Date(expiresAtUnix * 1000);
    if (expiresInSeconds && expiresInSeconds > 0) {
      return new Date(Date.now() + expiresInSeconds * 1000);
    }
    return undefined;
  }

  /**
   * A tenant's first connected number becomes its default, so sending works
   * immediately after onboarding without a second "pick a default" step. Later
   * numbers never steal the default — that is an explicit operator choice
   * (WhatsappAccountService.setDefault).
   */
  private async ensureTenantHasDefault(
    tenantId: string,
    account: WhatsappAccount,
  ): Promise<void> {
    if (account.is_default) return;

    const hasDefault = await this.accounts.exists({
      where: {
        tenant: { id: tenantId },
        is_default: true,
        deleted_at: IsNull(),
        id: Not(account.id),
      },
    });
    if (hasDefault) return;

    account.is_default = true;
    await this.accounts.save(account);
  }

  private async assertBranch(
    tenantId: string,
    branchId: string,
  ): Promise<void> {
    const ok = await this.branches.exists({
      where: { id: branchId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Branch not found in this tenant',
      });
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { AppError, ErrorCode } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import {
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_CONNECTION_STATUS,
  WhatsappAccountMode,
} from '../whatsapp.constants';

/** Where the resolved sending identity came from. */
export type WhatsappAccountSource = 'CUSTOM' | 'PLATFORM';

/**
 * A normalized, ready-to-send WhatsApp identity.
 *
 * `accessToken` is DECRYPTED here for the delivery adapter ONLY — it must never
 * be serialized into an API response or a log.
 */
export interface ResolvedWhatsappAccount {
  source: WhatsappAccountSource;
  mode: WhatsappAccountMode;
  id: string;
  phoneNumberId?: string;
  wabaId?: string;
  accessToken?: string;
  tokenExpiresAt?: Date;
}

/**
 * Resolves which WhatsApp account a tenant/branch should send from. This is the
 * ONLY place that knows the CUSTOM→PLATFORM precedence — keeping that decision
 * out of the messaging/execution services.
 *
 * TECH PROVIDER MODEL: every sending identity is a per-tenant WhatsappAccount
 * row. There is deliberately NO env-level shared number: ZiyaraTech owns one
 * Meta App, not a WhatsApp Business Account, so a tenant with no connected
 * account cannot send — it must complete Embedded Signup first. (`PLATFORM`
 * mode here means "a platform-provisioned account row for this tenant", still a
 * real per-tenant row, NOT a number shared across clinics.)
 *
 * Tenant isolation: every DB lookup is scoped by `tenant: { id: tenantId }`.
 */
@Injectable()
export class WhatsappAccountResolver {
  private readonly logger = new Logger('WhatsappAccountResolver');

  constructor(
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly encryption: EncryptionService,
  ) {}

  /** Explicit selection by account id (tenant-scoped, must be active & usable). */
  async byId(tenantId: string, accountId: string): Promise<ResolvedWhatsappAccount> {
    const account = await this.accounts.findOne({
      where: { id: accountId, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!account) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'WhatsApp account not found' });
    }
    if (!account.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp account is not active',
      });
    }
    if (account.connection_status !== WHATSAPP_CONNECTION_STATUS.CONNECTED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: this.disconnectedMessage(account.connection_status),
      });
    }
    if (this.isTokenExpired(account)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This WhatsApp connection has expired. Reauthorize your Meta connection to resume sending.',
      });
    }
    return this.fromEntity(account);
  }

  /**
   * Resolution for a branch:
   *   1. the branch's active CUSTOM account, else
   *   2. the branch's active PLATFORM account, else
   *   3. the tenant's default account (branch-agnostic — covers tenants that
   *      have connected a number but not bound it to this branch).
   * Throws if none is usable.
   */
  async forBranch(tenantId: string, branchId?: string): Promise<ResolvedWhatsappAccount> {
    if (branchId) {
      const custom = await this.findUsableByBranchMode(
        tenantId,
        branchId,
        WHATSAPP_ACCOUNT_MODE.CUSTOM,
      );
      if (custom) return this.fromEntity(custom);

      const platform = await this.findUsableByBranchMode(
        tenantId,
        branchId,
        WHATSAPP_ACCOUNT_MODE.PLATFORM,
      );
      if (platform) return this.fromEntity(platform);
    }

    return this.forTenant(tenantId);
  }

  /**
   * The tenant's default sending identity, ignoring branch. Used by flows that
   * carry no branch context (campaigns) and as `forBranch`'s final fallback.
   *
   * Selection order — most explicit wins:
   *   1. the account flagged `is_default` (the operator's stated choice; the DB
   *      guarantees at most one live default per tenant);
   *   2. the only usable account, when there is exactly one (nothing to choose);
   *   3. oldest active CUSTOM, else oldest usable — a LAST RESORT for tenants
   *      that have several numbers but never named a default. It is logged,
   *      because silently guessing which number a clinic messages patients from
   *      is a decision that deserves to be visible.
   */
  async forTenant(tenantId: string): Promise<ResolvedWhatsappAccount> {
    const usable = await this.usableAccounts(tenantId);

    const explicitDefault = usable.find((a) => a.is_default);
    if (explicitDefault) return this.fromEntity(explicitDefault);

    if (usable.length === 1) return this.fromEntity(usable[0]);

    if (usable.length > 1) {
      const fallback =
        usable.find((a) => a.mode === WHATSAPP_ACCOUNT_MODE.CUSTOM) ?? usable[0];
      this.logger.warn(
        `Tenant ${tenantId} has ${usable.length} usable WhatsApp numbers but no default; ` +
          `falling back to account ${fallback.id}. Set a default to make this explicit.`,
      );
      return this.fromEntity(fallback);
    }

    throw new AppError(ErrorCode.NOT_FOUND, {
      message:
        'This clinic has no connected WhatsApp number. Connect a WhatsApp Business account before sending.',
    });
  }

  /**
   * The tenant's live accounts that could actually send, oldest first.
   *
   * PUBLIC because it is the single definition of "sendable", shared by the
   * send path and by the eligible-accounts endpoint the campaign UI reads. If
   * the UI derived eligibility separately it would inevitably drift, and offer
   * the user a number the sender then refuses.
   */
  async usableAccounts(tenantId: string): Promise<WhatsappAccount[]> {
    const candidates = await this.accounts.find({
      where: { tenant: { id: tenantId }, is_active: true, deleted_at: IsNull() },
      order: { created_at: 'ASC' },
    });

    return candidates.filter((account) => this.isSendable(account));
  }

  /**
   * Whether this row may send RIGHT NOW.
   *
   * `connection_status` is checked here, not just `is_active`: they answer
   * different questions (Meta's view vs. the operator's switch). Without this a
   * DISCONNECTED or REVOKED account whose credentials are still on the row —
   * and disconnect deliberately keeps them, so a reconnect is cheap — would
   * keep sending, which is exactly what "disconnect" must prevent.
   */
  private isSendable(account: WhatsappAccount): boolean {
    if (!account.is_active) return false;
    if (account.connection_status !== WHATSAPP_CONNECTION_STATUS.CONNECTED) {
      this.logger.warn(
        `Skipping WhatsApp account ${account.id}: connection is ${account.connection_status}`,
      );
      return false;
    }
    if (this.isTokenExpired(account)) {
      this.logger.warn(`Skipping WhatsApp account ${account.id}: access token expired`);
      return false;
    }
    return !!account.phone_number_id && !!account.access_token;
  }

  /** Clinic-facing wording for a non-CONNECTED account (no provider internals). */
  private disconnectedMessage(status: string): string {
    switch (status) {
      case WHATSAPP_CONNECTION_STATUS.EXPIRED:
      case WHATSAPP_CONNECTION_STATUS.REVOKED:
        return 'This WhatsApp connection is no longer authorized. Reauthorize your Meta connection to resume sending.';
      case WHATSAPP_CONNECTION_STATUS.DISCONNECTED:
        return 'This WhatsApp account is disconnected. Reconnect it to resume sending.';
      default:
        return 'This WhatsApp account is not connected yet. Complete the WhatsApp connection to start sending.';
    }
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async findUsableByBranchMode(
    tenantId: string,
    branchId: string,
    mode: WhatsappAccountMode,
  ): Promise<WhatsappAccount | null> {
    const account = await this.accounts.findOne({
      where: {
        tenant: { id: tenantId },
        branch: { id: branchId },
        mode,
        is_active: true,
        deleted_at: IsNull(),
      },
    });
    if (!account) return null;
    // Same sendability rules as every other path — a disconnected branch number
    // must fall through to the tenant default, not silently fail the send.
    return this.isSendable(account) ? account : null;
  }

  private isTokenExpired(account: WhatsappAccount): boolean {
    return !!account.token_expires_at && account.token_expires_at.getTime() <= Date.now();
  }

  /** Maps the row to a send-ready identity, DECRYPTING the stored credential. */
  private fromEntity(account: WhatsappAccount): ResolvedWhatsappAccount {
    return {
      source: account.mode === WHATSAPP_ACCOUNT_MODE.PLATFORM ? 'PLATFORM' : 'CUSTOM',
      mode: (account.mode as WhatsappAccountMode) ?? WHATSAPP_ACCOUNT_MODE.CUSTOM,
      id: account.id,
      phoneNumberId: account.phone_number_id,
      wabaId: account.waba_id,
      accessToken: this.encryption.decrypt(account.access_token),
      tokenExpiresAt: account.token_expires_at,
    };
  }
}

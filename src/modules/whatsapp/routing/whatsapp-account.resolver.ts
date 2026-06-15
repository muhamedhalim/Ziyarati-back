import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { AppError, ErrorCode } from '../../../common/errors';
import {
  WHATSAPP_ACCOUNT_MODE,
  WhatsappAccountMode,
} from '../whatsapp.constants';

/** Where the resolved sending identity came from. */
export type WhatsappAccountSource = 'CUSTOM' | 'PLATFORM' | 'PLATFORM_ENV';

/**
 * A normalized, ready-to-send WhatsApp identity. `id` is absent for the env
 * PLATFORM fallback (no DB row). `accessToken` is included for the delivery
 * adapter ONLY — it must never be serialized into an API response or a log.
 */
export interface ResolvedWhatsappAccount {
  source: WhatsappAccountSource;
  mode: WhatsappAccountMode;
  id?: string;
  phoneNumberId?: string;
  wabaId?: string;
  accessToken?: string;
  tokenExpiresAt?: Date;
}

/**
 * Resolves which WhatsApp account a tenant/branch should send from. This is the
 * ONLY place that knows the hybrid CUSTOM→PLATFORM precedence and the env-level
 * shared number — keeping that decision out of the messaging/execution services.
 *
 * Tenant isolation: every DB lookup is scoped by `tenant: { id: tenantId }`.
 */
@Injectable()
export class WhatsappAccountResolver {
  private readonly logger = new Logger('WhatsappAccountResolver');

  constructor(
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly config: ConfigService,
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
    if (this.isTokenExpired(account)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp account access token has expired',
      });
    }
    return this.fromEntity(account);
  }

  /**
   * Hybrid resolution for a branch:
   *   1. branch's active CUSTOM account, else
   *   2. branch's active PLATFORM account, else
   *   3. the env-configured PLATFORM (shared SaaS) number.
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

    const envPlatform = this.envPlatform();
    if (envPlatform) return envPlatform;

    throw new AppError(ErrorCode.NOT_FOUND, {
      message: 'No usable WhatsApp account (no CUSTOM/PLATFORM account and no platform number configured)',
    });
  }

  /** The shared SaaS number from configuration, or null if not configured. */
  envPlatform(): ResolvedWhatsappAccount | null {
    const phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    if (!phoneNumberId || !accessToken) return null;
    return {
      source: 'PLATFORM_ENV',
      mode: WHATSAPP_ACCOUNT_MODE.PLATFORM,
      phoneNumberId,
      accessToken,
      wabaId: this.config.get<string>('WHATSAPP_WABA_ID') ?? undefined,
    };
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
    if (this.isTokenExpired(account)) {
      this.logger.warn(
        `Skipping ${mode} WhatsApp account ${account.id}: access token expired`,
      );
      return null;
    }
    return account;
  }

  private isTokenExpired(account: WhatsappAccount): boolean {
    return !!account.token_expires_at && account.token_expires_at.getTime() <= Date.now();
  }

  private fromEntity(account: WhatsappAccount): ResolvedWhatsappAccount {
    return {
      source: account.mode === WHATSAPP_ACCOUNT_MODE.PLATFORM ? 'PLATFORM' : 'CUSTOM',
      mode: (account.mode as WhatsappAccountMode) ?? WHATSAPP_ACCOUNT_MODE.CUSTOM,
      id: account.id,
      phoneNumberId: account.phone_number_id,
      wabaId: account.waba_id,
      accessToken: account.access_token,
      tokenExpiresAt: account.token_expires_at,
    };
  }
}

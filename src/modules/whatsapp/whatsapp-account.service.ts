import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, IsNull, Not, Repository } from 'typeorm';

import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWhatsappAccountDto } from './dto/create-whatsapp-account.dto';
import { UpdateWhatsappAccountDto } from './dto/update-whatsapp-account.dto';
import { WhatsappAccountFilterDto } from './dto/whatsapp-account-filter.dto';
import {
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_CONNECTION_STATUS,
  WHATSAPP_PROVIDER,
} from './whatsapp.constants';

/**
 * WhatsApp accounts — a tenant's connected (or to-be-connected) numbers.
 *
 * SCOPE OF THIS SERVICE: lifecycle and settings only. It deliberately cannot
 * write credentials — `access_token` / `waba_id` / `phone_number_id` are set
 * exclusively by MetaEmbeddedSignupService, which proves ownership with Meta
 * first. That split is why no client-supplied token can ever reach the DB.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`, every create
 * stamps it, and a referenced branch is re-validated against the tenant.
 *
 * SECURITY: reads return a SAFE VIEW that omits `access_token` entirely,
 * exposing only `hasCredentials`.
 */
@Injectable()
export class WhatsappAccountService {
  constructor(
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates an UNCONNECTED account slot (connection_status = PENDING). It
   * cannot send until Embedded Signup attaches a real credential to it.
   */
  async create(tenantId: string, dto: CreateWhatsappAccountDto) {
    if (dto.branchId) await this.assertBranch(tenantId, dto.branchId);

    const account = this.accounts.create({
      tenant: { id: tenantId } as Tenant,
      branch: dto.branchId ? ({ id: dto.branchId } as Branch) : null,
      mode: dto.mode ?? WHATSAPP_ACCOUNT_MODE.CUSTOM,
      provider: WHATSAPP_PROVIDER.META_CLOUD,
      connection_status: WHATSAPP_CONNECTION_STATUS.PENDING,
      is_active: dto.isActive ?? true,
    });
    const saved = await this.accounts.save(account);

    if (dto.isDefault) await this.setDefault(tenantId, saved.id);
    return this.findOne(tenantId, saved.id);
  }

  async findAll(tenantId: string, filter: WhatsappAccountFilterDto) {
    const where: FindOptionsWhere<WhatsappAccount> = { tenant: { id: tenantId } };
    if (filter.branchId) where.branch = { id: filter.branchId };
    if (filter.mode) where.mode = filter.mode;
    if (filter.isActive !== undefined) where.is_active = filter.isActive === 'true';

    const [rows, total] = await this.accounts.findAndCount({
      where,
      relations: { branch: true },
      // Default first: it is the answer to "which number does this clinic use?"
      order: { is_default: 'DESC', created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data: rows.map((a) => this.toView(a)), total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string) {
    const account = await this.loadEntity(tenantId, id);
    return this.toView(account);
  }

  async update(tenantId: string, id: string, dto: UpdateWhatsappAccountDto) {
    const account = await this.loadEntity(tenantId, id);

    if (dto.branchId !== undefined) {
      if (dto.branchId) {
        await this.assertBranch(tenantId, dto.branchId);
        account.branch = { id: dto.branchId } as Branch;
      } else {
        // Explicit null ⇒ promote to a tenant-level number.
        account.branch = null;
      }
    }
    if (dto.mode !== undefined) account.mode = dto.mode;
    if (dto.isActive !== undefined) account.is_active = dto.isActive;
    await this.accounts.save(account);

    if (dto.isDefault === true) await this.setDefault(tenantId, id);
    return this.findOne(tenantId, id);
  }

  async setActive(tenantId: string, id: string, active: boolean) {
    const account = await this.loadEntity(tenantId, id);
    account.is_active = active;
    // A deactivated number must not remain the default others fall back to.
    if (!active) account.is_default = false;
    await this.accounts.save(account);
    return this.findOne(tenantId, id);
  }

  /**
   * Makes `id` the tenant's default sending number.
   *
   * Transactional and unset-then-set: the DB enforces at most one live default
   * per tenant (partial unique index), so setting a new one without clearing the
   * old in the same transaction would violate it. This is the explicit answer to
   * "which number?" that replaced Phase 1's implicit oldest-row guess.
   */
  async setDefault(tenantId: string, id: string) {
    const account = await this.loadEntity(tenantId, id);
    if (!account.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'An inactive WhatsApp account cannot be the default.',
      });
    }

    await this.dataSource.transaction(async (mgr) => {
      await mgr.update(
        WhatsappAccount,
        { tenant: { id: tenantId }, is_default: true, deleted_at: IsNull(), id: Not(id) },
        { is_default: false },
      );
      await mgr.update(WhatsappAccount, { id }, { is_default: true });
    });
    return this.findOne(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const account = await this.loadEntity(tenantId, id);
    // Soft-delete frees the phone number for reconnection (the unique index is
    // partial on deleted_at IS NULL) and preserves history.
    await this.accounts.softRemove(account);
  }

  /** Connection health for the UI. Reflects Meta's view + the operator's switch. */
  async connectionStatus(tenantId: string, id: string) {
    const a = await this.loadEntity(tenantId, id);
    const hasCredentials = !!a.access_token;
    const expired = !!a.token_expires_at && a.token_expires_at.getTime() <= Date.now();
    return {
      accountId: a.id,
      isActive: a.is_active,
      connectionStatus: expired
        ? WHATSAPP_CONNECTION_STATUS.EXPIRED
        : a.connection_status,
      phoneNumberConfigured: !!a.phone_number_id,
      wabaConfigured: !!a.waba_id,
      hasCredentials,
      displayPhoneNumber: a.display_phone_number,
      verifiedName: a.verified_name,
      isDefault: a.is_default,
      connectedAt: a.connected_at,
      lastSyncedAt: a.last_synced_at,
      tokenExpiresAt: a.token_expires_at,
      connected:
        a.is_active &&
        hasCredentials &&
        !expired &&
        a.connection_status === WHATSAPP_CONNECTION_STATUS.CONNECTED,
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async loadEntity(tenantId: string, id: string): Promise<WhatsappAccount> {
    const account = await this.accounts.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { branch: true },
    });
    if (!account) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'WhatsApp account not found' });
    }
    return account;
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const ok = await this.branches.exists({
      where: { id: branchId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Branch not found in this tenant',
      });
    }
  }

  /** Strips the access_token secret, exposing only whether credentials exist. */
  private toView(account: WhatsappAccount) {
    const { access_token, ...rest } = account;
    return { ...rest, hasCredentials: !!access_token };
  }
}

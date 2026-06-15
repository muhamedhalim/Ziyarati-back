import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';

import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWhatsappAccountDto } from './dto/create-whatsapp-account.dto';
import { UpdateWhatsappAccountDto } from './dto/update-whatsapp-account.dto';
import { WhatsappAccountFilterDto } from './dto/whatsapp-account-filter.dto';
import { WHATSAPP_ACCOUNT_MODE } from './whatsapp.constants';

/**
 * WhatsApp business accounts (one per branch).
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`, every create
 * stamps it, and the referenced branch is re-validated against the tenant.
 *
 * SECURITY: `access_token` is a write-only secret. Read methods return a SAFE
 * VIEW that omits the token (exposing only `hasCredentials`); the raw entity is
 * accessed internally via `findEntityForSend` for the provider layer only.
 */
@Injectable()
export class WhatsappAccountService {
  constructor(
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
  ) {}

  async create(tenantId: string, dto: CreateWhatsappAccountDto) {
    await this.assertBranch(tenantId, dto.branchId);

    const mode = dto.mode ?? WHATSAPP_ACCOUNT_MODE.CUSTOM;

    // Uniqueness is per (branch, mode): a branch may hold one PLATFORM and one
    // CUSTOM account, but not two of the same mode.
    const existing = await this.accounts.findOne({
      where: { branch: { id: dto.branchId }, tenant: { id: tenantId }, mode },
    });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `This branch already has a ${mode} WhatsApp account`,
      });
    }

    const account = this.accounts.create({
      tenant: { id: tenantId } as Tenant,
      branch: { id: dto.branchId } as Branch,
      mode,
      phone_number_id: dto.phoneNumberId,
      waba_id: dto.wabaId,
      access_token: dto.accessToken,
      token_expires_at: dto.tokenExpiresAt ? new Date(dto.tokenExpiresAt) : undefined,
      is_active: dto.isActive ?? true,
    });
    const saved = await this.accounts.save(account);
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
      order: { created_at: 'DESC' },
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
    if (dto.phoneNumberId !== undefined) account.phone_number_id = dto.phoneNumberId;
    if (dto.wabaId !== undefined) account.waba_id = dto.wabaId;
    if (dto.accessToken !== undefined) account.access_token = dto.accessToken;
    if (dto.tokenExpiresAt !== undefined) {
      account.token_expires_at = dto.tokenExpiresAt ? new Date(dto.tokenExpiresAt) : undefined;
    }
    if (dto.isActive !== undefined) account.is_active = dto.isActive;
    await this.accounts.save(account);
    return this.findOne(tenantId, id);
  }

  async setActive(tenantId: string, id: string, active: boolean) {
    const account = await this.loadEntity(tenantId, id);
    account.is_active = active;
    await this.accounts.save(account);
    return this.findOne(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const account = await this.loadEntity(tenantId, id);
    await this.accounts.softRemove(account);
  }

  /** Derived connection status (no real provider call). */
  async connectionStatus(tenantId: string, id: string) {
    const a = await this.loadEntity(tenantId, id);
    const hasCredentials = !!a.access_token;
    return {
      accountId: a.id,
      isActive: a.is_active,
      phoneNumberConfigured: !!a.phone_number_id,
      wabaConfigured: !!a.waba_id,
      hasCredentials,
      connected: a.is_active && hasCredentials && !!a.phone_number_id && !!a.waba_id,
    };
  }

  /**
   * INTERNAL: returns the raw account entity (incl. access_token) for the
   * provider/messaging layer. If `accountId` is omitted, the tenant's first
   * active account is used. Never expose the result directly in a response.
   */
  async findEntityForSend(
    tenantId: string,
    accountId?: string,
  ): Promise<WhatsappAccount> {
    const account = accountId
      ? await this.accounts.findOne({
          where: { id: accountId, tenant: { id: tenantId }, deleted_at: IsNull() },
        })
      : await this.accounts.findOne({
          where: { tenant: { id: tenantId }, is_active: true, deleted_at: IsNull() },
          order: { created_at: 'ASC' },
        });
    if (!account) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: accountId ? 'WhatsApp account not found' : 'No active WhatsApp account for this tenant',
      });
    }
    if (!account.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp account is not active',
      });
    }
    return account;
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

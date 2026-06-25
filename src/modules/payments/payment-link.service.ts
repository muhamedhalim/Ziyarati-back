import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { FindOptionsWhere, Repository } from 'typeorm';

import { PaymentLink } from '../../entities/Payments/PaymentLink';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppError, ErrorCode } from '../../common/errors';

import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { QueryPaymentLinksDto } from './dto/query-payment-links.dto';
import { PAYMENT_LINK_STATUS, PAYMENT_LINK_TOKEN_BYTES } from './payments.constants';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';

/**
 * Shareable payment links (`payment_links`).
 *
 * Tenant-scoped via the `tenant` relation. The public token is a cryptographically
 * random, unguessable string (unique column). Resolving a token is still
 * tenant-scoped — the clinic views/tracks its own links; no cross-tenant lookup.
 */
@Injectable()
export class PaymentLinkService {
  constructor(
    @InjectRepository(PaymentLink)
    private readonly links: Repository<PaymentLink>,
    private readonly platformSettings: SystemSettingService,
  ) {}

  async create(tenantId: string, dto: CreatePaymentLinkDto): Promise<PaymentLink> {
    const ttlHours = await this.platformSettings.getTyped<number>(SettingKey.PAYMENT_LINK_TTL);
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + ttlHours * 3_600_000);

    return this.links.save(
      this.links.create({
        tenant: { id: tenantId } as Tenant,
        appointment: dto.appointmentId
          ? ({ id: dto.appointmentId } as Appointment)
          : undefined,
        amount: dto.amount,
        link_token: this.generateToken(),
        status: PAYMENT_LINK_STATUS.ACTIVE,
        expires_at: expiresAt,
      }),
    );
  }

  async list(tenantId: string, query: QueryPaymentLinksDto) {
    const where: FindOptionsWhere<PaymentLink> = { tenant: { id: tenantId } };
    if (query.status) where.status = query.status;

    const [data, total] = await this.links.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  async findOne(tenantId: string, id: string): Promise<PaymentLink> {
    const link = await this.links.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!link) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment link not found' });
    }
    return link;
  }

  /** Disable an active link so it can no longer be used. */
  async disable(tenantId: string, id: string): Promise<PaymentLink> {
    const link = await this.findOne(tenantId, id);
    link.status = PAYMENT_LINK_STATUS.DISABLED;
    return this.links.save(link);
  }

  /**
   * Resolve a link by its public token (tenant-scoped). Lazily flips an expired
   * ACTIVE link to EXPIRED so the tracked state stays accurate.
   */
  async getByToken(tenantId: string, token: string): Promise<PaymentLink> {
    const link = await this.links.findOne({
      where: { link_token: token, tenant: { id: tenantId } },
    });
    if (!link) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment link not found' });
    }
    if (
      link.status === PAYMENT_LINK_STATUS.ACTIVE &&
      link.expires_at &&
      link.expires_at.getTime() < Date.now()
    ) {
      link.status = PAYMENT_LINK_STATUS.EXPIRED;
      await this.links.save(link);
    }
    return link;
  }

  private generateToken(): string {
    return randomBytes(PAYMENT_LINK_TOKEN_BYTES).toString('base64url');
  }
}

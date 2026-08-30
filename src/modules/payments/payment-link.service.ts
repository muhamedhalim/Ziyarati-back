import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';

import { PaymentLink } from '../../entities/Payments/PaymentLink';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppError, ErrorCode } from '../../common/errors';

import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { QueryPaymentLinksDto } from './dto/query-payment-links.dto';
import {
  PAYMENT_LINK_STATUS,
  PAYMENT_LINK_TOKEN_BYTES,
  round2,
} from './payments.constants';
import { MerchantAccountService } from './merchant-account.service';
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
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    private readonly platformSettings: SystemSettingService,
    private readonly merchants: MerchantAccountService,
    private readonly dataSource: DataSource,
  ) {}

  async create(tenantId: string, dto: CreatePaymentLinkDto): Promise<PaymentLink> {
    // Marketplace gate: no live payment collection for an unapproved clinic.
    await this.merchants.assertChargeable(tenantId);

    // Booking-linked links take the SERVER-side booking price; a differing
    // client amount is rejected (same authority rule as PaymentService).
    let amount = dto.amount;
    if (dto.appointmentId) {
      const appointment = await this.dataSource.getRepository(Appointment).findOne({
        where: { id: dto.appointmentId, tenant: { id: tenantId } },
      });
      if (!appointment) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Appointment not found' });
      }
      const bookingAmount = round2(Number(appointment.total_amount ?? 0));
      if (!(bookingAmount > 0)) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Appointment has no payable total amount',
        });
      }
      if (
        dto.amount != null &&
        Math.round(Number(dto.amount) * 100) !== Math.round(bookingAmount * 100)
      ) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'Provided amount does not match the booking price. The booking price is read from the server.',
          publicContext: { expected: bookingAmount, provided: dto.amount },
        });
      }
      amount = bookingAmount;
    }

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
        amount,
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

  /**
   * Spec 014 (Clinic Platform Completion) — T067 (S4). Auto-generates a
   * payment link for a just-created appointment when the clinic requires
   * payment and the booking actually has an amount due — the same policy
   * `AiToolDispatchService.maybeCreatePaymentLink` already applies for the
   * AI conversational public-booking path, reused here for the deterministic
   * one so both booking paths converge on one payment-link decision.
   * `undefined` (never a thrown error) whenever no link should be issued —
   * a failure here must never fail the booking that already succeeded.
   */
  async createIfDue(
    tenantId: string,
    appointment: Appointment,
  ): Promise<
    { token: string; amount: number; currency: string; expiresAt?: string } | undefined
  > {
    try {
      const settings = await this.tenantSettings.findOne({
        where: { tenant: { id: tenantId } },
      });
      if (settings && !settings.payment_required) return undefined;

      const amount = round2(Number(appointment.total_amount ?? 0));
      if (!(amount > 0)) return undefined;

      const link = await this.create(tenantId, {
        appointmentId: appointment.id,
        amount,
      });
      return {
        token: link.link_token,
        amount: Number(link.amount),
        currency: appointment.currency,
        expiresAt: link.expires_at?.toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * ACTIVE links for one appointment — the sole read path other modules
   * (e.g. patient-initiated cancellation) use instead of touching the
   * `PaymentLink` entity directly (VER-009: this service is the only file
   * allowed to import it, enforced by `payment-link.controller.spec.ts`).
   */
  async findActiveForAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<PaymentLink[]> {
    return this.links.find({
      where: {
        tenant: { id: tenantId },
        appointment: { id: appointmentId },
        status: PAYMENT_LINK_STATUS.ACTIVE,
      },
    });
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

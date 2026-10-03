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
import { PaymentsConfig } from './payments.config';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';

/**
 * What the PUBLIC pay surface needs to know about a link — a plain object, not
 * the entity, so the `PaymentLink` import stays confined to this file (the
 * VER-009 guard in payment-link.controller.spec.ts proves it is the only one).
 * The link token IS the authorisation here: it is the capability the patient was
 * given, and nothing else (no tenant, no user) identifies the caller.
 */
export interface PublicPayLinkRef {
  linkId: string;
  tenantId: string;
  appointmentId: string;
  status: string;
  expiresAt?: Date;
}

/** Shape guard: junk tokens never reach the database. */
const PUBLIC_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

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
    private readonly config: PaymentsConfig,
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
      // The appointment's id is all `toView` needs, to know a booking is attached.
      loadRelationIds: { relations: ['appointment'] },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  async findOne(tenantId: string, id: string): Promise<PaymentLink> {
    const link = await this.links.findOne({
      where: { id, tenant: { id: tenantId } },
      loadRelationIds: { relations: ['appointment'] },
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
    | {
        token: string;
        amount: number;
        currency: string;
        expiresAt?: string;
        payUrl?: string;
      }
    | undefined
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
        payUrl: this.payUrlFor(link.link_token),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * The durable public URL a patient opens to pay. Built here, once, so every
   * surface that hands a link to a patient (public booking, WhatsApp / AI, staff)
   * produces the same URL — and none of them ever builds one itself.
   *
   * `undefined` when the deployment cannot complete a patient payment on that
   * page (legacy Moyasar in production): a patient is never handed a dead link.
   */
  payUrlFor(token: string): string | undefined {
    return this.config.patientPayPageServed
      ? this.config.payLinkUrl(token)
      : undefined;
  }

  /**
   * A link as the staff API returns it: the row plus the URL to share.
   *
   * Only a link tied to a booking has one. The public pay page prices a payment
   * from the appointment and names the payer from its patient; an amount-only
   * link has neither, so offering a URL for it would hand a patient a page that
   * can never take their money. Callers load the `appointment` relation (id
   * only is enough) for this to be decided correctly.
   */
  toView(link: PaymentLink): PaymentLink & { pay_url?: string } {
    const url = link.appointment ? this.payUrlFor(link.link_token) : undefined;
    return url ? { ...link, pay_url: url } : { ...link };
  }

  /**
   * Resolve a link for the PUBLIC pay surface. No tenant filter — the token is
   * the credential. Returns null for anything that is not a real link (unknown,
   * malformed): callers answer with one uniform 404 so a token's existence is
   * never disclosed. An expired ACTIVE link is lazily flipped to EXPIRED, same
   * as the staff read path.
   */
  async findPublicByToken(token: string): Promise<PublicPayLinkRef | null> {
    if (typeof token !== 'string' || !PUBLIC_TOKEN_SHAPE.test(token)) {
      return null;
    }
    const link = await this.links.findOne({
      where: { link_token: token },
      relations: { tenant: true, appointment: true },
    });
    // A link with no appointment cannot be paid through the booking surface.
    if (!link || !link.tenant?.id || !link.appointment?.id) return null;

    if (
      link.status === PAYMENT_LINK_STATUS.ACTIVE &&
      link.expires_at &&
      link.expires_at.getTime() < Date.now()
    ) {
      link.status = PAYMENT_LINK_STATUS.EXPIRED;
      await this.links.update(link.id, { status: PAYMENT_LINK_STATUS.EXPIRED });
    }
    return {
      linkId: link.id,
      tenantId: link.tenant.id,
      appointmentId: link.appointment.id,
      status: link.status,
      expiresAt: link.expires_at ?? undefined,
    };
  }

  /**
   * The booking was paid: its ACTIVE links are spent. Idempotent (only ACTIVE
   * rows move) and tenant-scoped, so the durable outcome job can call it on every
   * redelivery. A DISABLED or EXPIRED link stays as it was — that history matters.
   */
  async markUsedForAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<number> {
    const res = await this.links
      .createQueryBuilder()
      .update(PaymentLink)
      .set({ status: PAYMENT_LINK_STATUS.USED })
      .where('"appointmentId" = :appointmentId', { appointmentId })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('status = :active', { active: PAYMENT_LINK_STATUS.ACTIVE })
      .execute();
    return res.affected ?? 0;
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
    // A column UPDATE, not `save(link)`: the row was loaded with the appointment
    // as a bare id (`loadRelationIds`), which is not worth round-tripping
    // through the relation cascade logic just to flip one status.
    await this.links.update(link.id, { status: PAYMENT_LINK_STATUS.DISABLED });
    link.status = PAYMENT_LINK_STATUS.DISABLED;
    return link;
  }

  /**
   * Resolve a link by its public token (tenant-scoped). Lazily flips an expired
   * ACTIVE link to EXPIRED so the tracked state stays accurate.
   */
  async getByToken(tenantId: string, token: string): Promise<PaymentLink> {
    const link = await this.links.findOne({
      where: { link_token: token, tenant: { id: tenantId } },
      loadRelationIds: { relations: ['appointment'] },
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
      await this.links.update(link.id, { status: PAYMENT_LINK_STATUS.EXPIRED });
    }
    return link;
  }

  private generateToken(): string {
    return randomBytes(PAYMENT_LINK_TOKEN_BYTES).toString('base64url');
  }
}

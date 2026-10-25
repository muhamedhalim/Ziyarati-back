import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  FindOptionsWhere,
  ILike,
  In,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Not,
  Raw,
  Repository,
} from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { PaymentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { PaymentSucceededEvent } from '../../events/payment.events';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { PaymentsConfig } from './payments.config';
import { buildPayer } from './providers/payer.util';
import type { GatewayPayer } from './providers/payment-gateway.provider.interface';
import { MerchantAccountService } from './merchant-account.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { QueryPaymentsDto } from './dto/query-payments.dto';
import {
  CLINIC_REVENUE_PURPOSES,
  DEFAULT_PAYMENT_CURRENCY,
  PAYMENT_PURPOSE,
  SETTLEMENT_MODE,
  TRANSACTION_TYPE,
  isPlatformRevenuePurpose,
  round2,
  type PaymentPurpose,
  type SettlementMode,
} from './payments.constants';
import { PAYMENT_OUTCOME, enqueuePaymentOutcome } from './payment-outcome.outbox';

/** Statuses where money was captured, so a provider fee exists to be reconciled. */
const CAPTURED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/**
 * Options for {@link PaymentService.create} that are NEVER reachable from an
 * HTTP request body — deliberately a separate parameter, not a `CreatePaymentDto`
 * field. `payment.controller.ts` calls `create(tenantId, dto)` with exactly two
 * arguments; the global pipe's `whitelist: true, forbidNonWhitelisted: true`
 * would strip an extra DTO field anyway, but the real protection is that this
 * type does not exist on the wire at all. See plan §12.
 */
export interface CreatePaymentOptions {
  /**
   * What the payment is FOR. It decides whose money it is, and therefore the
   * whole routing of the charge:
   *
   *  - BOOKING / MANUAL (the default, by whether an appointment is attached) —
   *    the clinic's money: the merchant-onboarding gate applies and the
   *    marketplace split may apply.
   *  - ADDON / BILLING_UPGRADE — the clinic is the PAYER and the platform is
   *    the recipient (a resource add-on purchase, or the billing-upgrade
   *    flow). The clinic's OWN onboarding status is irrelevant, the split is
   *    forced to `null` so the whole charge settles to the platform account,
   *    and the row is recorded with `settlement_mode = NONE` so no clinic
   *    payout can ever claim it.
   *
   * This REPLACED the earlier `platformRevenue` boolean: two inputs that had to
   * agree is how a platform charge ends up classified as clinic revenue.
   */
  purpose?: PaymentPurpose;
}

/**
 * Payment lifecycle: PENDING → PAID / FAILED → (REFUNDED via RefundService).
 *
 * Tenant isolation: `payments` is tenant-scoped via the `tenant` relation, so
 * every query filters `where: { tenant: { id: tenantId } }`; the tenant is
 * always taken from the authenticated principal, never from input.
 *
 * The gateway is reached ONLY through `PaymentGatewayFactory` (provider
 * abstraction). State transitions run inside a DB transaction with a
 * pessimistic row lock to avoid races with concurrent confirms/webhooks.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger('PaymentService');

  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly transactions: TransactionService,
    private readonly financials: PaymentFinancialsService,
    private readonly merchants: MerchantAccountService,
    private readonly emitter: EventEmitter2,
    private readonly config: PaymentsConfig,
  ) {}

  async create(
    tenantId: string,
    dto: CreatePaymentDto,
    opts: CreatePaymentOptions = {},
  ) {
    // FND-027 / AD-02: a manual (no-appointment) payment carries neither the
    // appointment-based PENDING floor nor, usually, a client-supplied key —
    // the "New payment" UI never sends one. When the client supplies none on
    // that path, derive one deterministically (tenant + customer + amount +
    // a coarse time bucket) so the existing per-tenant unique index still
    // catches a double-submit. Appointment-based payments keep relying on
    // their own floor (the partial unique index + the "already paid"/"reuse
    // PENDING" checks in resolveBookingPrice) and are left untouched.
    const idempotencyKey =
      dto.idempotencyKey ??
      (!dto.appointmentId
        ? this.deriveManualIdempotencyKey(tenantId, dto)
        : undefined);

    // Idempotent create: a retry with the same key returns the existing payment.
    if (idempotencyKey) {
      const existing = await this.payments.findOne({
        where: { tenant: { id: tenantId }, idempotency_key: idempotencyKey },
      });
      if (existing) {
        return { payment: existing, status: existing.status, redirectUrl: undefined };
      }
    }

    // What this payment is for. An attached appointment is a booking payment;
    // anything else the caller did not classify is a manual (staff) payment —
    // the clinic's money either way. Only a service-level caller can name a
    // platform purpose (it is not on the DTO).
    const purpose: PaymentPurpose =
      opts.purpose ??
      (dto.appointmentId ? PAYMENT_PURPOSE.BOOKING : PAYMENT_PURPOSE.MANUAL);
    const platformRevenue = isPlatformRevenuePurpose(purpose);

    // Marketplace gate: a clinic whose merchant account is not APPROVED cannot
    // collect live money (no-op in the dev/test Noop flow). Skipped for
    // platform-revenue charges — the clinic is the PAYER here, not the
    // recipient, so its own merchant-onboarding status is irrelevant.
    if (!platformRevenue) {
      await this.merchants.assertChargeable(tenantId);
    }

    // Server-authoritative pricing: a payment that settles a booking takes its
    // amount/currency from the appointment row — NEVER from the client. A
    // client-supplied figure is only accepted as a cross-check.
    const authoritative = await this.resolveBookingPrice(tenantId, dto);

    // Refresh/double-click safety: an in-flight PENDING attempt for the same
    // booking is returned (with its stored hosted-page URL) — never re-charged.
    if (authoritative?.reusable) {
      const reused = authoritative.reusable;
      return {
        payment: reused,
        status: reused.status,
        redirectUrl: reused.metadata?.redirect_url as string | undefined,
      };
    }

    const amount = authoritative?.amount ?? dto.amount!;
    const currency =
      authoritative?.currency ?? dto.currency ?? DEFAULT_PAYMENT_CURRENCY;
    const customerId = dto.customerId ?? authoritative?.customerId;

    // FIN-006: a customer / branch named by the caller must belong to THIS
    // tenant. They were stored as bare FKs, so another tenant's customer id was
    // accepted and later leaked through the payment list's customer relation.
    if (dto.customerId) {
      const ok = await this.dataSource
        .getRepository(Customer)
        .count({ where: { id: dto.customerId, tenant: { id: tenantId } } });
      if (!ok) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Customer not found' });
      }
    }
    if (dto.branchId) {
      const ok = await this.dataSource
        .getRepository(Branch)
        .count({ where: { id: dto.branchId, tenant: { id: tenantId } } });
      if (!ok) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
      }
    }

    // The SERVER chooses the gateway (PAYMENT_PROVIDER). A client-supplied
    // `dto.gateway` is ignored: honoring it would let a caller steer a charge
    // onto a provider the platform did not intend.
    const provider = this.gateways.resolve();

    // Where a CLINIC charge settles: the clinic's own merchant (Tap Platform).
    // Resolved by the same capability rule that already gated this charge above,
    // so a charge can never carry routing the gate would have refused. Null for a
    // platform charge (the platform's own account) and for providers that do not
    // route by merchant. A Tap clinic charge WITHOUT routing is refused by the
    // adapter before any request is made — it can never land in our own account.
    const routing = platformRevenue
      ? null
      : await this.merchants.routingContext(tenantId);

    // Only gateways that cannot charge anonymously ask for payer identity, so
    // the others pay no extra read.
    const payer = provider.requiresPayerDetails
      ? await this.resolvePayer(tenantId, customerId, platformRevenue)
      : undefined;

    const settlementMode = this.settlementModeFor(
      platformRevenue,
      provider.settlesDirectlyToPayee === true,
    );

    let payment: Payment;
    try {
      payment = await this.payments.save(
        this.payments.create({
          tenant: { id: tenantId } as Tenant,
          branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
          appointment: dto.appointmentId
            ? ({ id: dto.appointmentId } as Appointment)
            : undefined,
          customer: customerId ? ({ id: customerId } as Customer) : undefined,
          amount,
          currency,
          status: PaymentStatus.PENDING,
          gateway: provider.name,
          purpose,
          settlement_mode: settlementMode,
          // FIN-P4: where this charge was routed, kept so every later confirmation
          // (webhook, return, sweep) can check the gateway still says the same.
          sub_merchant_id: routing?.settlementMerchantId,
          idempotency_key: idempotencyKey,
        }),
      );
    } catch (err) {
      const isUniqueViolation = (err as { code?: string })?.code === '23505';

      // Lost the one-PENDING-per-appointment unique race (double click /
      // concurrent tabs): return the winner instead of a second charge.
      if (dto.appointmentId && isUniqueViolation) {
        const winner = await this.payments.findOne({
          where: {
            tenant: { id: tenantId },
            appointment: { id: dto.appointmentId },
            status: PaymentStatus.PENDING,
          },
        });
        if (winner) {
          return {
            payment: winner,
            status: winner.status,
            redirectUrl: winner.metadata?.redirect_url as string | undefined,
          };
        }
      }

      // FND-027: lost the idempotency-key race (concurrent manual double
      // submit, derived or client-supplied) — same recovery pattern as
      // RefundService.create's idempotencyKey race.
      if (idempotencyKey && isUniqueViolation) {
        const winner = await this.payments.findOne({
          where: { tenant: { id: tenantId }, idempotency_key: idempotencyKey },
        });
        if (winner) {
          return {
            payment: winner,
            status: winner.status,
            redirectUrl: winner.metadata?.redirect_url as string | undefined,
          };
        }
      }
      throw err;
    }

    let redirectUrl: string | undefined;
    let createdGatewayId: string | undefined;
    try {
      const result = await provider.createPayment({
        tenantId,
        paymentId: payment.id,
        amount: Number(payment.amount),
        currency,
        description: dto.description,
        // Server-built — a client-supplied `dto.callbackUrl` is an open redirect.
        returnUrl: this.config.paymentReturnUrl(platformRevenue),
        // Booking funds belong to the clinic; add-ons/subscriptions to the platform.
        payee: platformRevenue ? 'platform' : 'clinic',
        settlementMerchantId: routing?.settlementMerchantId,
        customer: payer,
        reference: dto.appointmentId ? { order: dto.appointmentId } : undefined,
        metadata: { tenantId, paymentId: payment.id },
        idempotencyKey: dto.idempotencyKey,
      });
      redirectUrl = result.redirectUrl;

      if (result.gatewayPaymentId) {
        payment.gateway_payment_id = result.gatewayPaymentId;
        createdGatewayId = result.gatewayPaymentId;
      }
      // Some gateways capture immediately; reflect that without a second call.
      if (result.status === 'paid') {
        payment.status = PaymentStatus.PAID;
        payment.paid_at = new Date();
        // Freeze the fee breakdown (adapter-parsed when it reports them).
        this.financials.applyOnPaid(
          payment,
          result.fees,
        );
      } else if (result.status === 'failed') {
        payment.status = PaymentStatus.FAILED;
        // Adapters supply a short, user-safe reason (never raw provider text), so
        // staff can see why an online payment could not start.
        payment.failure_reason = result.failureReason;
      }

      // Persist the hosted-page URL so a refresh/retry can REUSE the active
      // payment attempt instead of creating a second gateway charge.
      if (redirectUrl) {
        payment.metadata = {
          ...(payment.metadata ?? {}),
          redirect_url: redirectUrl,
          // When the payer was handed that URL, as an ISO instant. Age checks use
          // THIS, never `created_at`: that column is `timestamp without time zone`,
          // which node-postgres reads back as LOCAL time, so any server not on UTC
          // sees a skew of its whole UTC offset.
          redirect_issued_at: new Date().toISOString(),
        };
      }

      // Ledger atomicity: the status change and its CHARGE audit row commit
      // together — never a status change without a transaction record.
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(Payment).save(payment);
        await this.transactions.record(
          tenantId,
          payment.id,
          {
            type: TRANSACTION_TYPE.CHARGE,
            amount: Number(payment.amount),
            status: result.status,
            gatewayTransactionId: result.gatewayPaymentId,
            raw: result.raw,
          },
          manager,
        );
        // REL-005: an outcome reached at create time (a gateway that captures
        // synchronously, or rejects the request outright) has consequences too —
        // an add-on purchase or billing upgrade is waiting on this payment. The
        // intent commits with the state change, never in a later best-effort emit.
        if (payment.status === PaymentStatus.PAID) {
          await enqueuePaymentOutcome(manager, {
            tenantId,
            paymentId: payment.id,
            outcome: PAYMENT_OUTCOME.PAID,
          });
        } else if (payment.status === PaymentStatus.FAILED) {
          await enqueuePaymentOutcome(manager, {
            tenantId,
            paymentId: payment.id,
            outcome: PAYMENT_OUTCOME.FAILED,
          });
        }
      });
    } catch (err) {
      // Leave the payment PENDING; confirm() or a webhook can still resolve it.
      this.logger.error(
        `Gateway createPayment failed for ${payment.id}`,
        err as Error,
      );
      // REL-002: the gateway may already hold a live charge we failed to record.
      // Never hand the payer a URL for a payment we are not tracking, and report
      // what the DATABASE says (PENDING), not the in-memory outcome that never
      // committed. The gateway echoes our payment id, so a webhook can still
      // find it; persist its id too when we got that far so the reconciliation
      // sweep (which only scans rows that have one) can see it.
      redirectUrl = undefined;
      payment.status = PaymentStatus.PENDING;
      payment.paid_at = undefined;
      await this.markCreateUncertain(payment, createdGatewayId);
    }

    return { payment, status: payment.status, redirectUrl };
  }

  /**
   * Who moves this payment's money to the clinic.
   *
   *  - platform revenue → NONE: the money IS the platform's, nothing is owed on.
   *  - the gateway settles straight to the clinic's merchant (Tap Platform) →
   *    PROVIDER: ZiyaraTech never holds the funds, so there is nothing to batch.
   *  - otherwise → INTERNAL: ZiyaraTech collected it and owes the clinic a payout.
   *
   * Decided once, at creation, from the provider that is actually charging.
   */
  private settlementModeFor(
    platformRevenue: boolean,
    providerSettlesToPayee: boolean,
  ): SettlementMode {
    if (platformRevenue) return SETTLEMENT_MODE.NONE;
    return providerSettlesToPayee
      ? SETTLEMENT_MODE.PROVIDER
      : SETTLEMENT_MODE.INTERNAL;
  }

  /**
   * Best-effort: flag a payment whose gateway create succeeded (or may have) but
   * whose bookkeeping did not commit. Failure here is logged, not thrown — the
   * caller is already on the error path and the webhook correlation still works.
   */
  private async markCreateUncertain(
    payment: Payment,
    gatewayPaymentId?: string,
  ): Promise<void> {
    try {
      // The URL was never handed out, so neither is the instant it would have been.
      const {
        redirect_url: _url,
        redirect_issued_at: _issuedAt,
        ...rest
      } = (payment.metadata ?? {}) as Record<string, unknown>;
      payment.metadata = { ...rest, create_uncertain: true };
      await this.payments.update(payment.id, {
        ...(gatewayPaymentId ? { gateway_payment_id: gatewayPaymentId } : {}),
        metadata: payment.metadata,
      });
    } catch (err) {
      this.logger.error(
        `Could not flag payment ${payment.id} as create_uncertain`,
        err as Error,
      );
    }
  }

  /**
   * Who is paying, for gateways that require identity. A tenant paying the
   * platform is identified by its contact details; a patient by their customer
   * record. Placeholder addresses (WhatsApp `@bot.internal`) are never passed on.
   */
  private async resolvePayer(
    tenantId: string,
    customerId: string | undefined,
    platformRevenue: boolean,
  ): Promise<GatewayPayer | undefined> {
    if (platformRevenue) {
      const tenant = await this.dataSource
        .getRepository(Tenant)
        .findOne({ where: { id: tenantId } });
      if (!tenant) return undefined;
      return buildPayer({
        name: tenant.legal_name ?? tenant.name,
        email: tenant.contact_email,
        phone: tenant.contact_phone,
        fallbackFirstName: 'Clinic',
      });
    }
    if (!customerId) return undefined;
    const customer = await this.dataSource
      .getRepository(Customer)
      .findOne({ where: { id: customerId, tenant: { id: tenantId } } });
    if (!customer) return undefined;
    return buildPayer({
      name: customer.full_name ?? customer.whatsapp_name,
      email: customer.email,
      phone: customer.phone,
      fallbackFirstName: 'Patient',
    });
  }

  /**
   * FND-027 / AD-02 — deterministic idempotency key for a manual (no-
   * appointment) payment when the client supplies none: tenant + customer +
   * amount + a 1-minute time bucket (same coarse-bucket pattern as
   * `queue.service.ts#enqueueUsageReportRun`). A double-click collides
   * (deduplicated); a genuinely later distinct payment (next bucket, or a
   * different amount/customer) does not.
   *
   * The existing `idempotency_key` unique constraint is GLOBAL (not
   * tenant-scoped — `UQ_59dcef70bd19850783c84f840e5` on `payments`, unlike
   * `refunds`' tenant-scoped `uq_refund_idem`), so the tenant id is embedded
   * directly in the derived string: this makes the key self-namespaced and
   * collision-safe regardless of that constraint shape, without requiring a
   * schema change.
   */
  private deriveManualIdempotencyKey(
    tenantId: string,
    dto: CreatePaymentDto,
  ): string {
    const amountKey = dto.amount != null ? Math.round(dto.amount * 100) : 'na';
    const customerKey = dto.customerId ?? 'anon';
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return `mp:${tenantId}:${customerKey}:${amountKey}:${minuteBucket}`;
  }

  /**
   * Booking-linked payments: resolve the authoritative price from the DATABASE.
   *
   * - The appointment must exist in the caller's tenant with a positive total.
   * - A client-supplied amount/currency is accepted only as a cross-check: any
   *   mismatch is rejected (anti amount/currency tampering) — the booking price
   *   is never adjusted to match what a client offers to pay.
   * - A payment with no appointment keeps the explicit-amount flow (staff POS
   *   style, `payments.manage` guarded), which then REQUIRES an amount.
   *
   * Returns null for non-booking payments.
   */
  private async resolveBookingPrice(
    tenantId: string,
    dto: CreatePaymentDto,
  ): Promise<{
    amount: number;
    currency: string;
    customerId?: string;
    /** An in-flight PENDING attempt to reuse instead of charging again. */
    reusable?: Payment;
  } | null> {
    if (!dto.appointmentId) {
      if (dto.amount == null) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'amount is required for a payment not linked to an appointment',
        });
      }
      return null;
    }

    const appointment = await this.dataSource.getRepository(Appointment).findOne({
      where: { id: dto.appointmentId, tenant: { id: tenantId } },
      relations: { customer: true },
    });
    if (!appointment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Appointment not found' });
    }

    const amount = round2(Number(appointment.total_amount ?? 0));
    if (!(amount > 0)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Appointment has no payable total amount',
      });
    }
    const currency = appointment.currency || DEFAULT_PAYMENT_CURRENCY;

    if (
      dto.amount != null &&
      Math.round(Number(dto.amount) * 100) !== Math.round(amount * 100)
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Provided amount does not match the booking price. The booking price is read from the server.',
        publicContext: { expected: amount, provided: dto.amount },
      });
    }
    if (dto.currency && dto.currency.toUpperCase() !== currency.toUpperCase()) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Provided currency does not match the booking currency. The booking currency is read from the server.',
        publicContext: { expected: currency, provided: dto.currency },
      });
    }

    // One financial obligation → one live charge. ANY existing PAID (or
    // partially refunded) payment blocks a second charge — regardless of later
    // FAILED attempts; an in-flight PENDING attempt is RETURNED for reuse
    // instead of creating a new gateway charge. (Backed by a partial UNIQUE
    // index on payments(appointmentId) WHERE status='PENDING' so a concurrent
    // race cannot slip a duplicate through.)
    const live = await this.payments.find({
      where: {
        tenant: { id: tenantId },
        appointment: { id: dto.appointmentId },
        status: In([
          PaymentStatus.PAID,
          PaymentStatus.PARTIALLY_REFUNDED,
          PaymentStatus.PENDING,
        ]),
      },
      order: { created_at: 'DESC' },
    });
    const paid = live.find((p) => p.status !== PaymentStatus.PENDING);
    if (paid) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This booking is already paid',
        publicContext: { paymentId: paid.id },
      });
    }

    return {
      amount,
      currency,
      customerId: appointment.customer?.id,
      reusable: live.find((p) => p.status === PaymentStatus.PENDING),
    };
  }

  async confirm(tenantId: string, id: string, dto: ConfirmPaymentDto): Promise<Payment> {
    // ── Phase 1: short tx — lock, idempotent checks, resolve the gateway id.
    // (The gateway is NOT called here, so the row lock is held only briefly.)
    //
    // The callback's return type is annotated EXPLICITLY (not inferred) because
    // without it, TS's inference across the two `return` shapes below gives
    // each branch the other's exclusive keys as `?: undefined` — so
    // `'settled' in prep` narrowing can no longer fully exclude the
    // non-`settled` branch, and `prep.settled` types as `Payment | undefined`
    // even though it is always a real `Payment` at runtime. That leak
    // propagated all the way out to this method's own inferred return type.
    // `gateway` stays `string | undefined` to match `Payment.gateway`'s own
    // optional column type — `PaymentGatewayFactory.resolve()` already accepts
    // an optional gateway name, so this is not narrowed further here.
    const prep = await this.dataSource.transaction<
      { settled: Payment } | { gatewayPaymentId: string; gateway: string | undefined; amount: number }
    >(async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({
        where: { id, tenant: { id: tenantId } },
        // CR-47: the tenant filter LEFT JOINs `tenants`; a bare FOR UPDATE would lock that row too.
        lock: { mode: 'pessimistic_write', tables: ['payments'] },
      });
      if (!payment) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
      }

      // Idempotent: already settled → nothing to verify.
      if (payment.status === PaymentStatus.PAID) {
        return { settled: payment };
      }
      if (
        payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED
      ) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Payment in status "${payment.status}" cannot be confirmed`,
        });
      }

      // FIN-003: a client-supplied charge id is NEVER linked to a payment of a
      // real gateway — it would let a payment be settled by an unrelated charge.
      // The id comes from the server's own gateway call (or the webhook /
      // reconciliation). Only the Noop simulator (dev/test; refused when
      // payments are live) still accepts a caller-supplied id.
      if (
        dto.gatewayPaymentId &&
        !payment.gateway_payment_id &&
        this.gateways.resolve(payment.gateway).acceptsClientChargeId === true
      ) {
        payment.gateway_payment_id = dto.gatewayPaymentId;
        await repo.save(payment);
      }
      if (!payment.gateway_payment_id) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'No gateway payment to verify for this payment',
        });
      }
      return {
        gatewayPaymentId: payment.gateway_payment_id,
        gateway: payment.gateway,
        amount: Number(payment.amount),
      };
    });

    if ('settled' in prep) return prep.settled;

    // ── Phase 2: gateway verify OUTSIDE any tx/lock (C3).
    const result = await this.gateways
      .resolve(prep.gateway)
      .verifyPayment(prep.gatewayPaymentId);

    // ── Phase 3: short tx — re-lock and finalize idempotently.
    const { payment: finalized, becamePaid } = await this.dataSource.transaction(
      async (manager) => {
        const repo = manager.getRepository(Payment);
        const payment = await repo.findOne({
          where: { id, tenant: { id: tenantId } },
          // CR-47: lock the payment row only, not the joined tenant row.
          lock: { mode: 'pessimistic_write', tables: ['payments'] },
        });
        if (!payment) {
          throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
        }

        await this.transactions.record(
          tenantId,
          payment.id,
          {
            type: TRANSACTION_TYPE.VERIFY,
            amount: Number(payment.amount),
            status: result.status,
            gatewayTransactionId: prep.gatewayPaymentId,
            raw: result.raw,
          },
          manager,
        );

        // A webhook may have settled it between phases — don't regress a terminal
        // state. A refund that landed between the phases counts too: REFUNDED /
        // PARTIALLY_REFUNDED were paid, and must never be moved back to PAID.
        if (
          payment.status === PaymentStatus.PAID ||
          payment.status === PaymentStatus.REFUNDED ||
          payment.status === PaymentStatus.PARTIALLY_REFUNDED
        ) {
          return { payment, becamePaid: false };
        }
        if (result.status === 'paid') {
          // Anti under/over-payment & amount tampering: when the gateway reports
          // what it actually captured, it MUST match our expected amount/currency
          // before we book it PAID. No-op when the provider can't report it, so the
          // Noop/dev flow is unaffected.
          this.assertCapturedMatches(
            payment,
            result,
            // FIN-008: a real gateway must REPORT what it captured.
            this.gateways.resolve(prep.gateway).reportsCapturedAmount !== false,
          );
          payment.status = PaymentStatus.PAID;
          payment.paid_at = new Date();
          this.financials.applyOnPaid(
            payment,
            result.fees,
          );
          const saved = await repo.save(payment);
          // REL-005: same transaction as the PAID flip.
          await enqueuePaymentOutcome(manager, {
            tenantId,
            paymentId: payment.id,
            outcome: PAYMENT_OUTCOME.PAID,
          });
          return { payment: saved, becamePaid: true };
        }
        if (result.status === 'failed') {
          payment.status = PaymentStatus.FAILED;
          const saved = await repo.save(payment);
          await enqueuePaymentOutcome(manager, {
            tenantId,
            paymentId: payment.id,
            outcome: PAYMENT_OUTCOME.FAILED,
          });
          return { payment: saved, becamePaid: false };
        }
        // 'pending' / 'unknown': the gateway could not say — change nothing.
        return { payment: await repo.save(payment), becamePaid: false };
      },
    );

    // Same domain event the webhook path emits, AFTER the commit — so booking
    // confirmation / notifications fire exactly once whichever signal lands
    // first (the webhook path skips its emit when the status is already PAID).
    if (becamePaid) {
      const withRels = await this.payments.findOne({
        where: { id: finalized.id },
        relations: { customer: true, appointment: true },
      });
      this.emitter.emit(
        PaymentSucceededEvent.eventName,
        new PaymentSucceededEvent(
          tenantId,
          finalized.id,
          Number(finalized.amount),
          finalized.currency,
          withRels?.customer?.id,
          withRels?.appointment?.id,
        ),
      );
    }
    return finalized;
  }

  /**
   * Reconcile the gateway-captured amount/currency against our expected payment.
   * Throws (leaving the payment PENDING for review) on any mismatch — stops an
   * underpaid / overpaid / amount-tampered gateway charge from being booked PAID
   * (e.g. a client-created charge linked via `confirm` for a different amount).
   * With `requireFigures` (every real gateway) absent figures are a rejection;
   * only the Noop simulator may omit them.
   */
  private assertCapturedMatches(
    payment: Payment,
    result: { capturedMinorUnits?: number; capturedCurrency?: string },
    requireFigures = false,
  ): void {
    const expectedC = Math.round(Number(payment.amount) * 100);
    if (
      requireFigures &&
      (result.capturedMinorUnits == null || !result.capturedCurrency)
    ) {
      this.logger.error(
        `Payment ${payment.id} confirm rejected: gateway did not report the captured amount/currency`,
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The gateway did not report the captured amount; payment cannot be confirmed yet',
      });
    }
    if (
      result.capturedMinorUnits != null &&
      result.capturedMinorUnits !== expectedC
    ) {
      this.logger.error(
        `Payment ${payment.id} confirm rejected: captured ${result.capturedMinorUnits} ≠ expected ${expectedC} minor units`,
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Captured amount does not match the expected payment amount',
        publicContext: {
          expectedMinorUnits: expectedC,
          capturedMinorUnits: result.capturedMinorUnits,
        },
      });
    }
    if (
      result.capturedCurrency &&
      result.capturedCurrency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      this.logger.error(
        `Payment ${payment.id} confirm rejected: captured currency ${result.capturedCurrency} ≠ expected ${payment.currency}`,
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Captured currency does not match the expected payment currency',
        publicContext: {
          expected: payment.currency,
          captured: result.capturedCurrency,
        },
      });
    }
  }

  /**
   * Close an abandoned PENDING attempt so a fresh one can replace it (the
   * one-PENDING-per-booking index would otherwise hold the booking hostage to a
   * charge nobody can complete: an expired hosted page, or an attempt that never
   * reached the gateway and so never gave the payer a URL).
   *
   * Returns false when the row is no longer PENDING (a webhook settled it while
   * the caller was deciding) — the caller must then re-read, never overwrite.
   * Only PENDING can move: a payment that was captured is never touched here.
   */
  async supersedePending(tenantId: string, id: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({
        where: { id, tenant: { id: tenantId } },
        // CR-47: the tenant filter LEFT JOINs `tenants`; a bare FOR UPDATE would lock that row too.
        lock: { mode: 'pessimistic_write', tables: ['payments'] },
      });
      if (!payment || payment.status !== PaymentStatus.PENDING) return false;

      payment.status = PaymentStatus.FAILED;
      payment.failure_reason = 'Superseded by a new payment attempt';
      await repo.save(payment);
      await this.transactions.record(
        tenantId,
        payment.id,
        {
          type: TRANSACTION_TYPE.VERIFY,
          amount: Number(payment.amount),
          status: 'failed',
          gatewayTransactionId: payment.gateway_payment_id,
        },
        manager,
      );
      return true;
    });
  }

  async getStatus(tenantId: string, id: string) {
    const payment = await this.findOne(tenantId, id);
    return {
      id: payment.id,
      status: payment.status,
      settlement_status: payment.settlement_status,
      amount: payment.amount,
      currency: payment.currency,
      gateway: payment.gateway,
      gateway_payment_id: payment.gateway_payment_id,
      paid_at: payment.paid_at,
    };
  }

  async list(tenantId: string, query: QueryPaymentsDto) {
    const where: FindOptionsWhere<Payment> = { tenant: { id: tenantId } };
    if (query.status) where.status = query.status;
    if (query.settlementStatus) where.settlement_status = query.settlementStatus;
    if (query.customerId) where.customer = { id: query.customerId };
    // The clinic's payments page is about the clinic's own money. Its add-on and
    // billing-upgrade payments (the clinic paying the PLATFORM) used to be mixed
    // in; they are only returned when asked for by name.
    where.purpose = query.purpose
      ? query.purpose
      : In([...CLINIC_REVENUE_PURPOSES]);
    if (query.feeStatus) {
      // A fee only exists for captured money, so the filter implies it.
      where.status = query.status ?? In([...CAPTURED_PAYMENT_STATUSES]);
      where.fees_reconciled_at =
        query.feeStatus === 'RECONCILED' ? Not(IsNull()) : IsNull();
    }
    if (query.from && query.to) {
      where.created_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.created_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.created_at = LessThan(new Date(query.to));
    }

    // Support lookup: a provider charge id, or the start of a payment id. (Names are not
    // searched here — use the customer filter.) `%`, `_` and `\` are matched literally.
    const term = query.search?.trim().replace(/[\\%_]/g, '\\$&');
    const filter: FindOptionsWhere<Payment> | FindOptionsWhere<Payment>[] = term
      ? [
          { ...where, gateway_payment_id: ILike(`%${term}%`) },
          {
            ...where,
            id: Raw((alias) => `CAST(${alias} AS text) ILIKE :idTerm`, {
              idTerm: `${term}%`,
            }),
          },
        ]
      : where;

    const [data, total] = await this.payments.findAndCount({
      where: filter,
      // The page names the payer. Without the relation every row showed "—" — and only
      // the NAME is sent on (see `forList`), not the patient's contact card.
      relations: { customer: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map((p) => this.forList(p)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * A row of the clinic's payments list: sanitised like every client payment, and the
   * payer reduced to what the page shows — an id and a display name (the same fallback
   * `resolvePayer` uses), never the phone / e-mail on the customer record.
   */
  private forList(payment: Payment): Payment {
    const safe = this.sanitizeForClient(payment);
    const c = safe.customer;
    if (!c) return safe;
    return {
      ...safe,
      customer: {
        id: c.id,
        full_name: c.full_name ?? c.whatsapp_name,
      } as Customer,
    };
  }

  async findOne(tenantId: string, id: string): Promise<Payment> {
    const payment = await this.payments.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!payment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
    }
    return this.sanitizeForClient(payment);
  }

  /**
   * FND-030 — `failure_reason` is populated from RAW, unvalidated gateway
   * webhook text (`payment-webhook.service.ts`: `event.data?.source?.message`
   * verbatim) — never safe to return to a client as-is (could contain
   * card-adjacent fragments, internal gateway jargon, or anything the
   * provider chose to put there). Sanitized VALUE only, on READ — the field
   * name/type are unchanged, and the raw text is never touched in the
   * database (kept for support/reconciliation, e.g.
   * `payment-reconciliation.service.ts`/`marketplace-finance.service.ts`,
   * both internal-only reads).
   */
  private sanitizeForClient(payment: Payment): Payment {
    if (!payment.failure_reason) return payment;
    return { ...payment, failure_reason: 'Payment was declined by the provider.' };
  }
}

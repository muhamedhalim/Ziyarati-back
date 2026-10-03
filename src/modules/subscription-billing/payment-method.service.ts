import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import {
  PAYMENT_METHOD_STATUS,
  TenantPaymentMethod,
} from '../../entities/SaaS-Core/TenantPaymentMethod';
import { AppError, ErrorCode } from '../../common/errors';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type SavedPaymentMethodInfo,
  type SavedPaymentMethodRef,
} from './payment/payment-provider.interface';

/** What a clinic user may see of its saved card — NEVER the provider's ids. */
export interface PaymentMethodView {
  id: string;
  provider: string;
  brand: string | null;
  scheme: string | null;
  lastFour: string | null;
  /** FALSE = renewals cannot charge this card without the clinic; it must pay by hand. */
  recurringCapable: boolean;
  isDefault: boolean;
  createdAt: Date;
}

/**
 * A clinic's saved card — the gateway's ids + display facts, never card data.
 *
 * Tenant isolation: every read/write filters by `tenant_id` taken from the
 * authenticated principal; another tenant's method id resolves to a plain 404.
 */
@Injectable()
export class PaymentMethodService {
  private readonly logger = new Logger('PaymentMethodService');

  constructor(
    @InjectRepository(TenantPaymentMethod)
    private readonly methods: Repository<TenantPaymentMethod>,
    @Inject(PAYMENT_PROVIDER)
    private readonly payment: PaymentProvider,
  ) {}

  toView(m: TenantPaymentMethod): PaymentMethodView {
    return {
      id: m.id,
      provider: m.provider,
      brand: m.brand ?? null,
      scheme: m.scheme ?? null,
      lastFour: m.last_four ?? null,
      recurringCapable: m.recurring_capable,
      isDefault: m.is_default,
      createdAt: m.created_at,
    };
  }

  /** The tenant's active default card, or null. */
  async getDefault(tenantId: string): Promise<PaymentMethodView | null> {
    const m = await this.findDefault(tenantId);
    return m ? this.toView(m) : null;
  }

  /**
   * The card a renewal may charge WITHOUT the clinic present: the active
   * default, and only when its scheme supports that. Null = none, which the
   * provider answers with `TOKENIZATION_UNAVAILABLE` (clinic pays by hand).
   */
  async resolveForCharge(
    tenantId: string,
  ): Promise<{ id: string; ref: SavedPaymentMethodRef } | null> {
    const m = await this.findDefault(tenantId);
    if (!m || !m.recurring_capable) return null;
    return {
      id: m.id,
      ref: {
        customerId: m.provider_customer_id,
        cardId: m.provider_card_id,
        agreementId: m.provider_payment_agreement_id,
      },
    };
  }

  /**
   * Records the card a checkout just saved and makes it the tenant's default.
   * Runs inside the SETTLE transaction so the card and the payment that saved it
   * commit (or roll back) together.
   *
   * A card id that already belongs to a DIFFERENT tenant is never re-attached: one
   * physical saved card can only ever serve one clinic. That is logged loudly and
   * skipped — the payment itself still settles.
   */
  async upsertDefault(
    manager: EntityManager,
    tenantId: string,
    info: SavedPaymentMethodInfo,
    sourceInvoiceId: string,
  ): Promise<TenantPaymentMethod | null> {
    const repo = manager.getRepository(TenantPaymentMethod);

    const existing = await repo.findOne({
      where: { provider_card_id: info.cardId },
    });
    if (existing && existing.tenant_id !== tenantId) {
      this.logger.error(
        `ALERT: saved card ${existing.id} is already attached to another tenant — not re-attached to ${tenantId} (invoice ${sourceInvoiceId})`,
      );
      return null;
    }

    // Demote the current default FIRST: the partial unique index allows only one.
    await repo
      .createQueryBuilder()
      .update(TenantPaymentMethod)
      .set({ is_default: false })
      .where('tenant_id = :tenantId', { tenantId })
      .andWhere('is_default = true')
      .andWhere('status = :active', { active: PAYMENT_METHOD_STATUS.ACTIVE })
      .andWhere('provider_card_id <> :cardId', { cardId: info.cardId })
      .execute();

    const row =
      existing ??
      repo.create({
        tenant_id: tenantId,
        provider: info.provider,
        provider_card_id: info.cardId,
        source_invoice_id: sourceInvoiceId,
      });
    row.provider = info.provider;
    row.provider_customer_id = info.customerId;
    row.provider_payment_agreement_id = info.agreementId;
    row.brand = info.brand ?? null;
    row.scheme = info.scheme ?? null;
    row.last_four = info.lastFour ?? null;
    row.recurring_capable = info.recurringCapable;
    row.is_default = true;
    row.status = PAYMENT_METHOD_STATUS.ACTIVE;
    row.revoked_at = null;
    return repo.save(row);
  }

  /**
   * Removes a saved card: revoked locally FIRST (so it can never be charged
   * again), then deleted at the provider best-effort. A provider that cannot
   * confirm the delete does not keep the card usable — it is only reported.
   */
  async remove(
    tenantId: string,
    id: string,
  ): Promise<{ removed: true; providerDeleted: boolean }> {
    const m = await this.methods.findOne({
      where: { id, tenant_id: tenantId },
    });
    if (!m) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Payment method not found',
      });
    }
    if (m.status !== PAYMENT_METHOD_STATUS.ACTIVE) {
      return { removed: true, providerDeleted: false };
    }

    m.status = PAYMENT_METHOD_STATUS.REVOKED;
    m.is_default = false;
    m.revoked_at = new Date();
    await this.methods.save(m);

    let providerDeleted = false;
    try {
      providerDeleted = await this.payment.deletePaymentMethod({
        customerId: m.provider_customer_id,
        cardId: m.provider_card_id,
        agreementId: m.provider_payment_agreement_id,
      });
    } catch (err) {
      this.logger.warn(
        `Provider delete failed for saved card ${m.id}: ${(err as Error)?.message}`,
      );
    }
    if (!providerDeleted) {
      this.logger.warn(
        `Saved card ${m.id} revoked locally but not confirmed deleted at the provider`,
      );
    }
    return { removed: true, providerDeleted };
  }

  private findDefault(tenantId: string): Promise<TenantPaymentMethod | null> {
    return this.methods.findOne({
      where: {
        tenant_id: tenantId,
        is_default: true,
        status: PAYMENT_METHOD_STATUS.ACTIVE,
      },
    });
  }
}

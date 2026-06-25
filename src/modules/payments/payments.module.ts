import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformModule } from '../platform/platform.module';

import { Payment } from '../../entities/Payments/Payment';
import { PaymentGateway } from '../../entities/Payments/PaymentGateway';
import { PaymentLink } from '../../entities/Payments/PaymentLink';
import { Transaction } from '../../entities/Payments/Transaction';
import { Refund } from '../../entities/Payments/Refund';
import { Invoice } from '../../entities/Payments/Invoice';
import { InvoiceItem } from '../../entities/Payments/InvoiceItem';
import { Settlement } from '../../entities/Payments/Settlement';
import { SettlementItem } from '../../entities/Payments/SettlementItem';

import { PaymentGatewayService } from './payment-gateway.service';
import { PaymentService } from './payment.service';
import { PaymentLinkService } from './payment-link.service';
import { TransactionService } from './transaction.service';
import { RefundService } from './refund.service';
import { InvoiceService } from './invoice.service';
import { InvoiceItemService } from './invoice-item.service';
import { SettlementService } from './settlement.service';
import { SettlementItemService } from './settlement-item.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { RefundRecoveryService } from './refund-recovery.service';
import { FinancialMetricsService } from './financial-metrics.service';
import { PaymentWebhookService } from './payment-webhook.service';

import { PaymentGatewayController } from './payment-gateway.controller';
import { PaymentsOpsController } from './payments-ops.controller';
import { PaymentController } from './payment.controller';
import { PaymentLinkController } from './payment-link.controller';
import { TransactionController } from './transaction.controller';
import { RefundController } from './refund.controller';
import { InvoiceController } from './invoice.controller';
import { SettlementController } from './settlement.controller';
import { PaymentWebhookController } from './payment-webhook.controller';

import { MoyasarProvider } from './providers/moyasar.provider';
import { NoopGatewayProvider } from './providers/noop-gateway.provider';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { PAYMENT_GATEWAY_PROVIDERS } from './providers/payment-gateway.provider.interface';
import { MoyasarWebhookVerifier } from './webhooks/moyasar-webhook.verifier';
import { PaymentsSchemaBootstrap } from './payments-schema.bootstrap';

/**
 * Payments Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / RolesGuard /
 * @RequirePermissions), ActiveTenantGuard + TenantContextService (tenant scope),
 * and the global JwtAuthGuard.
 *
 * PLATFORM vs TENANT split (critical business rule):
 *  - PaymentGateway config is PLATFORM-owned — its controller is super-admin only.
 *  - Everything else is strictly tenant-scoped; tenants only CONSUME payments.
 *
 * The gateway integration is decoupled behind a strategy/factory: real adapters
 * (MoyasarProvider) register into PAYMENT_GATEWAY_PROVIDERS; PaymentGatewayFactory
 * resolves one and falls back to NoopGatewayProvider when none is configured, so
 * the app runs end-to-end locally with no live credentials. Moyasar credentials
 * + webhook secret are platform config (ConfigService) only — never per tenant.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      PaymentGateway,
      PaymentLink,
      Transaction,
      Refund,
      Invoice,
      InvoiceItem,
      Settlement,
      SettlementItem,
    ]),
    // Provides SystemSettingService for payment link TTL and default currency.
    PlatformModule,
  ],
  controllers: [
    PaymentGatewayController,
    PaymentsOpsController,
    PaymentController,
    PaymentLinkController,
    TransactionController,
    RefundController,
    InvoiceController,
    SettlementController,
    PaymentWebhookController,
  ],
  providers: [
    PaymentGatewayService,
    PaymentService,
    PaymentLinkService,
    TransactionService,
    RefundService,
    InvoiceService,
    InvoiceItemService,
    SettlementService,
    SettlementItemService,
    SettlementAdjustmentService,
    RefundRecoveryService,
    FinancialMetricsService,
    PaymentWebhookService,
    // Gateway provider abstraction (Moyasar adapter + Noop fallback + factory).
    MoyasarProvider,
    NoopGatewayProvider,
    PaymentGatewayFactory,
    MoyasarWebhookVerifier,
    PaymentsSchemaBootstrap,
    {
      provide: PAYMENT_GATEWAY_PROVIDERS,
      useFactory: (moyasar: MoyasarProvider) => [moyasar],
      inject: [MoyasarProvider],
    },
  ],
  exports: [
    PaymentService,
    InvoiceService,
    // Exposed so the background worker's settlements processor can reuse it.
    SettlementService,
    // Exposed so the background worker's refunds reaper can reuse it.
    RefundRecoveryService,
    // Exposed so the worker can write the reaper heartbeat.
    FinancialMetricsService,
  ],
})
export class PaymentsModule {}

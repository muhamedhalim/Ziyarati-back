import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformModule } from '../platform/platform.module';
import { PaymentsCoreModule } from './payments-core.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { StorageModule } from '../storage/storage.module';

import { Payment } from '../../entities/Payments/Payment';
import { PaymentGateway } from '../../entities/Payments/PaymentGateway';
import { PaymentLink } from '../../entities/Payments/PaymentLink';
import { Transaction } from '../../entities/Payments/Transaction';
import { Refund } from '../../entities/Payments/Refund';
import { Invoice } from '../../entities/Payments/Invoice';
import { InvoiceItem } from '../../entities/Payments/InvoiceItem';
import { Settlement } from '../../entities/Payments/Settlement';
import { SettlementItem } from '../../entities/Payments/SettlementItem';
import { MerchantAccount } from '../../entities/Payments/MerchantAccount';
import { PaymentReconciliationException } from '../../entities/Payments/PaymentReconciliationException';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { PaymentGatewayService } from './payment-gateway.service';
import { PaymentService } from './payment.service';
import { PaymentLinkService } from './payment-link.service';
import { TransactionService } from './transaction.service';
import { RefundService } from './refund.service';
import { RefundCompletionService } from './refund-completion.service';
import { RefundWebhookService } from './refund-webhook.service';
import { InvoiceService } from './invoice.service';
import { InvoiceItemService } from './invoice-item.service';
import { InvoiceDocumentService } from './invoice-document.service';
import { InvoiceAuditService } from './invoice-audit.service';
import { SettlementService } from './settlement.service';
import { SettlementItemService } from './settlement-item.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { RefundRecoveryService } from './refund-recovery.service';
import { FinancialMetricsService } from './financial-metrics.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { MerchantAccountService } from './merchant-account.service';
import { TapOnboardingService } from './tap-onboarding.service';
import { PublicPaymentService } from './public-payment.service';
import { ReconciliationExceptionService } from './reconciliation/reconciliation-exception.service';
import { ProviderReconciliationService } from './reconciliation/provider-reconciliation.service';

import { PaymentGatewayController } from './payment-gateway.controller';
import { PaymentsOpsController } from './payments-ops.controller';
import { PaymentController } from './payment.controller';
import { PaymentLinkController } from './payment-link.controller';
import { TransactionController } from './transaction.controller';
import { RefundController } from './refund.controller';
import { InvoiceController } from './invoice.controller';
import { SettlementController } from './settlement.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { MerchantAccountController } from './merchant-account.controller';
import { MerchantAccountAdminController } from './merchant-account-admin.controller';
import { TapOnboardingCallbackController } from './tap-onboarding-callback.controller';
import { PublicPaymentController } from './public-payment.controller';
import { PlatformReconciliationController } from './reconciliation/platform-reconciliation.controller';

import { MoyasarProvider } from './providers/moyasar.provider';
import { NoopGatewayProvider } from './providers/noop-gateway.provider';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { PAYMENT_GATEWAY_PROVIDERS } from './providers/payment-gateway.provider.interface';
import { MoyasarWebhookVerifier } from './webhooks/moyasar-webhook.verifier';
import { TapGatewayProvider } from './providers/tap/tap-gateway.provider';
import { TapWebhookVerifier } from './webhooks/tap-webhook.verifier';
import { TapWebhookHandler } from './webhooks/tap-webhook.handler';
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
 * (MoyasarProvider legacy, TapGatewayProvider) register into
 * PAYMENT_GATEWAY_PROVIDERS; PaymentGatewayFactory resolves one and falls back
 * to NoopGatewayProvider when none is configured, so the app runs end-to-end
 * locally with no live credentials. Gateway credentials + webhook secrets are
 * platform config (ConfigService) only — never per tenant.
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
      MerchantAccount,
      PaymentReconciliationException,
      TenantSetting,
      SubscriptionInvoice,
      AuditLog,
    ]),
    // Provides SystemSettingService for payment link TTL and default currency.
    PlatformModule,
    // PaymentsConfig + the single TapApiClient, shared with subscription-billing
    // (which this module imports — see PaymentsCoreModule for why it is separate).
    PaymentsCoreModule,
    // T084 (spec 014, US5) — PaymentReconciliationService's subscription
    // sweep verifies through the SAME PAYMENT_PROVIDER binding
    // BillingService uses, never a second one.
    SubscriptionBillingModule,
    // T096 (spec 014, US12) — InvoiceController presigns the rendered
    // document's download URL. StorageService itself has no worker-only
    // guard (unlike DocumentRendererService), so this is safe in the API
    // process.
    StorageModule,
  ],
  controllers: [
    PaymentGatewayController,
    PaymentsOpsController,
    // MUST precede PaymentController: Nest registers routes in this order, and
    // `GET /payments/:id` (a uuid-validated param) would otherwise capture
    // `GET /payments/merchant-account` first and answer 400 — the clinic could
    // never read its own onboarding status. (Guarded by payments.module.spec.)
    MerchantAccountController,
    PaymentController,
    PaymentLinkController,
    TransactionController,
    RefundController,
    InvoiceController,
    SettlementController,
    PaymentWebhookController,
    MerchantAccountAdminController,
    // Tap clinic-onboarding callback (public, token-authenticated, advisory only).
    TapOnboardingCallbackController,
    // Patient pay page API (public, authorised by the pay-link token).
    PublicPaymentController,
    // The reconciliation queue + manual report import (super admin).
    PlatformReconciliationController,
  ],
  providers: [
    PaymentGatewayService,
    PaymentService,
    PaymentLinkService,
    TransactionService,
    RefundService,
    RefundCompletionService,
    RefundWebhookService,
    InvoiceService,
    InvoiceItemService,
    InvoiceDocumentService,
    InvoiceAuditService,
    SettlementService,
    SettlementItemService,
    SettlementAdjustmentService,
    RefundRecoveryService,
    FinancialMetricsService,
    PaymentFinancialsService,
    PaymentWebhookService,
    PaymentReconciliationService,
    MerchantAccountService,
    TapOnboardingService,
    PublicPaymentService,
    ReconciliationExceptionService,
    ProviderReconciliationService,
    // PaymentsConfig (typed config), TapApiClient and OnlinePaymentCapabilityService
    // come from PaymentsCoreModule.
    // Gateway provider abstraction (Moyasar adapter + Noop fallback + factory).
    MoyasarProvider,
    TapGatewayProvider,
    NoopGatewayProvider,
    PaymentGatewayFactory,
    MoyasarWebhookVerifier,
    TapWebhookVerifier,
    TapWebhookHandler,
    PaymentsSchemaBootstrap,
    {
      provide: PAYMENT_GATEWAY_PROVIDERS,
      // Resolution is by NAME (PAYMENT_PROVIDER for new payments, the stored
      // Payment.gateway for historic rows), so listing both is what keeps
      // legacy Moyasar rows verifiable/refundable once Tap is the default.
      useFactory: (moyasar: MoyasarProvider, tap: TapGatewayProvider) => [
        moyasar,
        tap,
      ],
      inject: [MoyasarProvider, TapGatewayProvider],
    },
  ],
  exports: [
    PaymentService,
    InvoiceService,
    // T095 (spec 014, US12) — AnalyticsProcessor (worker) assembles the
    // document data here, then renders it via DocumentRendererService
    // (worker-role-only) — this service itself stays constructible in
    // either process.
    InvoiceDocumentService,
    // Exposed so the background worker's settlements processor can reuse it.
    SettlementService,
    // Exposed so the background worker's refunds reaper can reuse it.
    RefundRecoveryService,
    // Exposed so the background worker's reconciliation sweep can reuse it.
    PaymentReconciliationService,
    // Exposed so the worker can write the reaper heartbeat.
    FinancialMetricsService,
    // The daily provider reconciliation runs in the worker; the exception queue is
    // also raised from the outcome consumer there.
    ProviderReconciliationService,
    ReconciliationExceptionService,
    // Exposed so the AI booking flow can auto-generate a payment link for
    // uninsured bookings when the tenant requires online payment (see
    // AiToolDispatchService.bookAppointment) — reuses the same
    // create()/assertChargeable() path the staff dashboard uses manually.
    PaymentLinkService,
  ],
})
export class PaymentsModule {}

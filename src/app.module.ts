import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { MarketplaceThrottlerGuard } from './common/throttler/marketplace-throttler.guard';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { AppRedisService } from './queue/app-redis.service';
import { FailsafeThrottlerStorage } from './queue/failsafe-throttler-storage';

import { typeOrmFactory } from './config/typeorm.config';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { SchemaGuardModule } from './config/schema-guard.module';
import { MetricsHttpModule } from './metrics/metrics-http.module';
import { MetricsService } from './metrics/metrics.service';

import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { CsrfGuard } from './modules/auth/guards/csrf.guard';
import { SubscriptionAccessGuard } from './modules/subscription-billing/guards/subscription-access.guard';
import { FeatureGuard } from './modules/subscription-billing/guards/feature.guard';
import { TenantModule } from './modules/tenant/tenant.module';
import { AppointmentModule } from './modules/appointment/appointment.module';
import { StaffModule } from './modules/staff/staff.module';
import { SubscriptionBillingModule } from './modules/subscription-billing/subscription-billing.module';
import { ResourcePricingModule } from './modules/resource-pricing/resource-pricing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { AiModule } from './modules/ai/ai.module';
import { AiOrchestratorModule } from './modules/ai-orchestrator/ai-orchestrator.module';
import { AiMemoryModule } from './modules/ai-memory/ai-memory.module';
import { AiRealtimeModule } from './modules/ai-realtime/ai-realtime.module';
import { PlatformAiMonitoringModule } from './modules/platform-ai-monitoring/platform-ai-monitoring.module';
import { PublicDiscoveryModule } from './modules/public-discovery/public-discovery.module';
import { GuestChatModule } from './modules/guest-chat/guest-chat.module';
import { PublicBookingModule } from './modules/public-booking/public-booking.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CrmModule } from './modules/crm/crm.module';
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module';
import { BillingUpgradeModule } from './modules/billing-upgrades/billing-upgrade.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ClinicDashboardModule } from './modules/clinic-dashboard/clinic-dashboard.module';
import { PlatformModule } from './modules/platform/platform.module';
import { PlatformStaffModule } from './modules/platform-staff/platform-staff.module';
import { PlatformSalesModule } from './modules/platform-sales/platform-sales.module';
import { PlatformSupportModule } from './modules/platform-support/platform-support.module';
import { MaintenanceGuard } from './modules/platform/guards/maintenance.guard';
import { IntegrationModule } from './modules/integration/integration.module';
import { IntegrationPlatformModule } from './modules/integration-platform/integration-platform.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { ServicesModule } from './modules/services/services.module';
import { StorageModule } from './modules/storage/storage.module';
import { VerificationAuditModule } from './modules/verification-audit/verification-audit.module';
import { AdminNotificationModule } from './modules/admin-notifications/admin-notification.module';
import { PlatformFinanceModule } from './modules/platform-finance/platform-finance.module';
import { PlatformMonitoringModule } from './modules/platform-monitoring/platform-monitoring.module';
import { RbacAuditModule } from './modules/rbac-audit/rbac-audit.module';
import { PlatformUsageModule } from './modules/platform-usage/platform-usage.module';
import { PlatformDashboardModule } from './modules/platform-dashboard/platform-dashboard.module';
import { EmailModule } from './modules/email/email.module';
import { TenantContextModule } from './core/tenant-context/tenant-context.module';
import { BranchScopeModule } from './core/branch-scope/branch-scope.module';
import { StaffScopeModule } from './core/staff-scope/staff-scope.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { SeedModule } from './seed/seed.module';

// Spec 014 "Clinic Platform Completion" — scaffolded empty in T006.
import { PatientActionsModule } from './modules/patient-actions/patient-actions.module';
import { MedicalRecordsModule } from './modules/medical-records/medical-records.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { PatientQueueModule } from './modules/patient-queue/patient-queue.module';
// DocumentsModule is intentionally NOT imported here — its one provider
// (DocumentRendererService, T021) refuses to construct outside the worker
// process; only worker.module.ts imports it.
import { ReportExportModule } from './modules/report-export/report-export.module';
import { ActivityLogModule } from './modules/activity-log/activity-log.module';
import { DataGovernanceModule } from './modules/data-governance/data-governance.module';

import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      cache: true,
      validate,
    }),

    // Global event bus for domain events (appointment/payment/subscription).
    // wildcard: false — exact string matching only (no glob patterns).
    EventEmitterModule.forRoot({ global: true, wildcard: false }),

    // Baseline abuse protection for every route, including the @Public()
    // webhook/health endpoints that carry no auth at all. A generous default
    // (normal dashboard polling must never trip it); routes with a real DoS/
    // abuse profile (webhook ingestion, Embedded Signup) set a tighter
    // per-route limit via @Throttle(). Relaxed to a no-op ceiling under Jest
    // (NODE_ENV=test) so the e2e suite's request bursts against one shared
    // storage never fail on request volume rather than assertions.
    //
    // Redis-backed storage (gap-closure pass — see
    // docs/CACHING_QUEUES_AUDIT.md H9): the default in-memory `ThrottlerStorage`
    // is per-process, so with N API replicas the effective limit was `300 × N`
    // and it reset on every deploy — inconsistent with the tenant/campaign rate
    // limiter, which was already correctly Redis-backed. Reuses
    // `AppRedisService.application` (the existing fail-fast KV connection,
    // already used for exactly this class of lightweight command) rather than
    // opening a new socket — `ThrottlerStorageRedisService` does not manage a
    // Redis instance passed to it directly, so `AppRedisService` keeps sole
    // ownership of that connection's lifecycle (connect/close on shutdown).
    //
    // `PERF-CACHE-001` fix: wrapped in `FailsafeThrottlerStorage` so a Redis
    // outage degrades this global, first-in-chain, `@Public()`-reaching guard
    // to local in-memory limiting instead of throwing a raw unhandled `ioredis`
    // error on every request (see that file's docstring for the full
    // fail-open-vs-fail-closed rationale).
    ThrottlerModule.forRootAsync({
      inject: [AppRedisService, MetricsService, ConfigService],
      useFactory: (
        appRedis: AppRedisService,
        metrics: MetricsService,
        config: ConfigService,
      ) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60_000,
            // Test env: effectively unlimited, unless a spec lowers it on purpose
            // via E2E_THROTTLE_LIMIT (read ONLY when NODE_ENV=test — it can never
            // change the production ceiling).
            limit:
              process.env.NODE_ENV === 'test'
                ? Number(process.env.E2E_THROTTLE_LIMIT) > 0
                  ? Number(process.env.E2E_THROTTLE_LIMIT)
                  : 1_000_000
                : 300,
          },
        ],
        storage: new FailsafeThrottlerStorage(
          new ThrottlerStorageRedisService(appRedis.application),
          metrics,
          config.get<number>('AUTH_ABUSE_FALLBACK_WIDTH', 4096),
        ),
      }),
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService) =>
        typeOrmFactory(config, 'api', metrics),
    }),

    TenantContextModule,
    // Encrypt-at-rest for third-party provider credentials. Global — any module
    // storing a provider secret needs it, and it must never be optional.
    CryptoModule,
    // Background-job producers (BullMQ): registers the queues so any service can
    // enqueue. The HTTP API NEVER runs workers — processors live in WorkerModule.
    QueueModule,
    // Branch-scope authority — the sibling of TenantContextModule ("which
    // tenant?" / "which branches inside it?"). Declared after QueueModule
    // because it injects AppRedisService for its membership cache.
    BranchScopeModule,
    // Sibling scope authority -- "which StaffProfile, if any, IS this caller?".
    // Same @Global registration rationale as BranchScopeModule above; also
    // injects AppRedisService for its own-profile cache.
    StaffScopeModule,
    HealthModule,
    MetricsModule,

    SchemaGuardModule,
    MetricsHttpModule,
    AuthModule,
    TenantModule,
    AppointmentModule,
    StaffModule,
    SubscriptionBillingModule,
    ResourcePricingModule,
    NotificationsModule,
    CampaignsModule,
    WhatsappModule,
    ConversationsModule,
    AiModule,
    AiOrchestratorModule,
    AiMemoryModule,
    AiRealtimeModule,
    PlatformAiMonitoringModule,
    PublicDiscoveryModule,
    GuestChatModule,
    PublicBookingModule,
    WorkflowModule,
    PaymentsModule,
    CrmModule,
    SupportTicketsModule,
    BillingUpgradeModule,
    AnalyticsModule,
    ClinicDashboardModule,
    PlatformModule,
    PlatformStaffModule,
    PlatformSalesModule,
    PlatformSupportModule,
    IntegrationModule,
    IntegrationPlatformModule,
    SchedulingModule,
    ServicesModule,
    StorageModule,
    VerificationAuditModule,
    AdminNotificationModule,
    PlatformFinanceModule,
    PlatformMonitoringModule,
    RbacAuditModule,
    PlatformUsageModule,
    PlatformDashboardModule,
    EmailModule,
    SeedModule,

    // Spec 014 "Clinic Platform Completion" — scaffolded empty in T006.
    PatientActionsModule,
    MedicalRecordsModule,
    WaitlistModule,
    PatientQueueModule,
    ReportExportModule,
    ActivityLogModule,
    DataGovernanceModule,
  ],

  providers: [
    // Runs first: cheap IP-bucketed rejection before any auth/DB work, and the
    // only guard that also applies to @Public() routes.
    //
    // Contract C11 (Marketplace, P1 remediation): subclasses the stock
    // ThrottlerGuard to key PublicDiscoveryController's routes per-visitor
    // instead of per-IP when a valid platform API key + visitor id are
    // presented — see that guard's own docstring. Every other controller's
    // throttling (including PublicBookingController) is completely
    // unaffected; this only overrides `getTracker()`, and only elevates for
    // one specific controller class.
    {
      provide: APP_GUARD,
      useClass: MarketplaceThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Runs after authentication; enforces double-submit CSRF on cookie-authed
    // state-changing requests (no-op for safe methods and non-cookie clients).
    {
      provide: APP_GUARD,
      useClass: CsrfGuard,
    },
    // Blocks all non-super-admin requests when platform.maintenance_mode is enabled.
    // Runs after JWT so req.user is populated; super-admins bypass the gate.
    {
      provide: APP_GUARD,
      useClass: MaintenanceGuard,
    },
    // Billing enforcement layer (runs after auth; reads request.user). Both are
    // no-ops unless a route carries @RequireActiveSubscription() / @RequireFeature():
    //  - SubscriptionAccessGuard: global mode → free override → paid subscription →
    //    feature override (a tenant-specific /platform/feature-flags override for
    //    THIS route's own @RequireFeature() key substitutes for a subscription).
    //  - FeatureGuard: per-tenant feature entitlement (enforced only in paid mode).
    //    Must run AFTER SubscriptionAccessGuard so the broad gate's feature-override
    //    bypass above and this guard's own resolver-based check agree.
    {
      provide: APP_GUARD,
      useClass: SubscriptionAccessGuard,
    },
    {
      provide: APP_GUARD,
      useClass: FeatureGuard,
    },
  ],
})
export class AppModule {}

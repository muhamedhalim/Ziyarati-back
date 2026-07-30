import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { AppRedisService } from './queue/app-redis.service';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { typeOrmFactory } from './config/typeorm.config';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsHttpModule } from './metrics/metrics-http.module';

import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { CsrfGuard } from './modules/auth/guards/csrf.guard';
import { SubscriptionAccessGuard } from './modules/subscription-billing/guards/subscription-access.guard';
import { FeatureGuard } from './modules/subscription-billing/guards/feature.guard';
import { TenantModule } from './modules/tenant/tenant.module';
import { AppointmentModule } from './modules/appointment/appointment.module';
import { StaffModule } from './modules/staff/staff.module';
import { SubscriptionBillingModule } from './modules/subscription-billing/subscription-billing.module';
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
import { WorkflowModule } from './modules/workflow/workflow.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CrmModule } from './modules/crm/crm.module';
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module';
import { BillingUpgradeModule } from './modules/billing-upgrades/billing-upgrade.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PlatformModule } from './modules/platform/platform.module';
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
import { EmailModule } from './modules/email/email.module';
import { TenantContextModule } from './core/tenant-context/tenant-context.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { SeedModule } from './seed/seed.module';

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
    ThrottlerModule.forRootAsync({
      inject: [AppRedisService],
      useFactory: (appRedis: AppRedisService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60_000,
            limit: process.env.NODE_ENV === 'test' ? 1_000_000 : 300,
          },
        ],
        storage: new ThrottlerStorageRedisService(appRedis.application),
      }),
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => typeOrmFactory(config, 'api'),
    }),

    TenantContextModule,
    // Encrypt-at-rest for third-party provider credentials. Global — any module
    // storing a provider secret needs it, and it must never be optional.
    CryptoModule,
    // Background-job producers (BullMQ): registers the queues so any service can
    // enqueue. The HTTP API NEVER runs workers — processors live in WorkerModule.
    QueueModule,
    HealthModule,
    MetricsModule,
    MetricsHttpModule,
    AuthModule,
    TenantModule,
    AppointmentModule,
    StaffModule,
    SubscriptionBillingModule,
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
    WorkflowModule,
    PaymentsModule,
    CrmModule,
    SupportTicketsModule,
    BillingUpgradeModule,
    AnalyticsModule,
    PlatformModule,
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
    EmailModule,
    SeedModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
    // Runs first: cheap IP-bucketed rejection before any auth/DB work, and the
    // only guard that also applies to @Public() routes.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
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
    //  - SubscriptionAccessGuard: global mode → free override → paid subscription.
    //  - FeatureGuard: per-tenant feature entitlement (enforced only in paid mode).
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

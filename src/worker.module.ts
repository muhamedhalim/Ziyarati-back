import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { typeOrmFactory } from './config/typeorm.config';
import { validate } from './config/env.validation';

import { Tenant } from './entities/SaaS-Core/Tenant';
import { Subscription } from './entities/SaaS-Core/Subscription';
import { OutboxJob } from './entities/Campaigns/OutboxJob';
import { User } from './entities/Auth&RBAC/User';
import { RefreshToken } from './entities/Auth&RBAC/RefreshToken';
import { PasswordReset } from './entities/Auth&RBAC/PasswordReset';
import { AuthTokenMaintenanceService } from './modules/auth/auth-token-maintenance.service';
// Provided directly here (not exported by SubscriptionBillingModule) so
// that module never has to import NotificationsModule/EmailModule just to
// satisfy this worker-only service's constructor — see the plan's rationale
// on FreeAccessNoticeService's own docblock.
import { FreeAccessNoticeService } from './modules/subscription-billing/free-access-notice.service';

import { TenantContextModule } from './core/tenant-context/tenant-context.module';
import { BranchScopeModule } from './core/branch-scope/branch-scope.module';
import { StaffScopeModule } from './core/staff-scope/staff-scope.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { QueueModule } from './queue/queue.module';
import { MetricsModule } from './metrics/metrics.module';
import { ObservabilityEventsModule } from './common/logging/observability-events.listener';
import { SchemaGuardModule } from './config/schema-guard.module';
import { MetricsService } from './metrics/metrics.service';
import {
  bullPrefix,
  resolveWorkerRole,
  queuesForRole,
} from './queue/queue.constants';
import { blockingConnectionOptions } from './queue/redis.config';

// Domain modules whose EXISTING services the processors reuse (no logic copied).
import { NotificationsModule } from './modules/notifications/notifications.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { AiModule } from './modules/ai/ai.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PlatformModule } from './modules/platform/platform.module';
import { SubscriptionBillingModule } from './modules/subscription-billing/subscription-billing.module';
import { EmailModule } from './modules/email/email.module';
// REL-005 — `PaymentOutcomeService` (below) applies the idempotent post-payment
// consumers directly. A provider in THIS module only sees what a module it
// imports DIRECTLY exports, so each owner is imported here by name. The first is
// already in the worker's tree transitively; the other two were API-only until now.
import { AppointmentModule } from './modules/appointment/appointment.module';
import { BillingUpgradeModule } from './modules/billing-upgrades/billing-upgrade.module';
import { ResourcePricingModule } from './modules/resource-pricing/resource-pricing.module';
import { PaymentOutcomeService } from './worker/payment-outcome.service';
// T183 (spec 014, US13) — AnalyticsProcessor's `analytics.exportGenerate`
// branch and PlatformProcessor's `platform.exportExpiry` branch.
import { ReportExportModule } from './modules/report-export/report-export.module';

import { WorkerTenantsService } from './worker/worker-tenants.service';
import { QueueMonitorService } from './worker/queue-monitor.service';
import { ScheduleRegistrarService } from './worker/schedule-registrar.service';
import { OutboxRelayService } from './worker/outbox-relay.service';
import { SesFeedbackConsumer } from './modules/email/feedback/ses-feedback.consumer';

import { NotificationsProcessor } from './worker/processors/notifications.processor';
import { WhatsappProcessor } from './worker/processors/whatsapp.processor';
import { WhatsappWebhookProcessor } from './worker/processors/whatsapp-webhook.processor';
import { WhatsappMediaProcessor } from './worker/processors/whatsapp-media.processor';
import {
  CampaignLaunchProcessor,
  CampaignFanoutProcessor,
  CampaignDispatchProcessor,
} from './worker/processors/campaigns.processor';
import { CampaignDlqRecoveryProcessor } from './worker/processors/campaign-dlq-recovery.processor';
import { AiProcessor } from './worker/processors/ai.processor';
import { AnalyticsProcessor } from './worker/processors/analytics.processor';
import { SettlementsProcessor } from './worker/processors/settlements.processor';
import { SubscriptionsProcessor } from './worker/processors/subscriptions.processor';
import { RefundsProcessor } from './worker/processors/refunds.processor';
import { PaymentsProcessor } from './worker/processors/payments.processor';
import { PlatformProcessor } from './worker/processors/platform.processor';
import { EmailProcessor } from './worker/processors/email.processor';
import { UsageReportProcessor } from './worker/processors/usage-report.processor';
import { PlatformUsageModule } from './modules/platform-usage/platform-usage.module';
import { AiMemoryModule } from './modules/ai-memory/ai-memory.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { WorkflowProcessor } from './worker/processors/workflow.processor';
import { WebhookDeliveryProcessor } from './worker/processors/webhook-delivery.processor';
import { IntegrationPlatformModule } from './modules/integration-platform/integration-platform.module';
// Spec 014 (Clinic Platform Completion) — T021. WORKER ROLE ONLY: this
// module's one provider (DocumentRendererService) refuses to construct
// anywhere `PROCESS_ROLE !== 'worker'`, so it must NEVER be imported into
// AppModule (the API root) — only here.
import { DocumentsModule } from './modules/documents/documents.module';
import { StorageModule } from './modules/storage/storage.module';
import { IntegrationImportProcessor } from './worker/processors/integration-import.processor';
import { IntegrationSyncProcessor } from './worker/processors/integration-sync.processor';
import { IntegrationInboundProcessor } from './worker/processors/integration-inbound.processor';
import { IntegrationRecoveryProcessor } from './worker/processors/integration-recovery.processor';
// Spec 014 (Clinic Platform Completion) — T160. PlatformProcessor's
// waitlistEvaluate/waitlistExpiry branches reuse WaitlistService/
// WaitlistOfferService — same "processors reuse existing domain modules"
// shape as every other import in this list.
import { WaitlistModule } from './modules/waitlist/waitlist.module';
// T174 (spec 014, US10) — PlatformProcessor's queueDayClose branch reuses
// PatientQueueService.closeUnresolvedEntries — same shape as WaitlistModule
// immediately above.
import { PatientQueueModule } from './modules/patient-queue/patient-queue.module';

/**
 * Which processors/infra services this process instantiates, resolved ONCE at
 * module load from `WORKER_ROLE` (Phase 0 correction — see
 * docs/CACHING_QUEUES_AUDIT.md §0.3/§0.5, not the original audit's rejected
 * "just raise DB_POOL_MAX" plan).
 *
 * `all` (default — no env var set, e.g. every existing deployment and local
 * dev) is BYTE-IDENTICAL to pre-Phase-0 behaviour: every processor and infra
 * service registers in one process, nothing changed. Only an operator who
 * explicitly sets `WORKER_ROLE=critical` (everything except the recipient
 * dispatch hot path) or `WORKER_ROLE=dispatch` (ONLY the recipient dispatch
 * hot path, `campaigns.processRecipient`) on two separately-deployed
 * processes activates the split — each deployment then gets its own
 * `DB_POOL_MAX` and its own replica count, instead of one shared pool sized
 * for the combined theoretical concurrency.
 *
 * `WorkerTenantsService`/`QueueMonitorService`/`ScheduleRegistrarService`/
 * `OutboxRelayService` are cron/monitoring/relay infra unrelated to campaign
 * dispatch (they cover analytics, settlements, subscriptions, notifications,
 * the outbox relay, and cross-queue failed/stalled logging) — they run under
 * `critical`/`all` only, so a `dispatch`-role deployment doesn't duplicate
 * cron registration or double up on QueueEvents connections for no reason.
 */
// Production must set WORKER_ROLE explicitly rather than silently falling
// back to `all` (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.5).
// Checked against the RAW env var (never the Joi-defaulted ConfigService
// value, which by validation time is always 'all'/'critical'/'dispatch' and
// can no longer distinguish "unset" from "explicitly all") — mirrors how
// `resolveWorkerRole()` itself reads `process.env.WORKER_ROLE` directly.
// Deliberately NOT in the shared `env.validation.ts` `validate()`: that
// function also gates the API process's boot, which has no reason to ever
// set WORKER_ROLE, so a check there would wrongly fail API deployments too.
if (
  process.env.NODE_ENV === 'production' &&
  process.env.WORKER_ROLE === undefined
) {
  throw new Error(
    '❌ WORKER_ROLE must be set explicitly in production — one of "all", "critical", or "dispatch". ' +
      'See docs/CACHING_QUEUES_AUDIT.md §0.5/§0.8.5: silently defaulting to "all" in production ' +
      'means every deployment gets the unsplit worker (shared DB pool, shared connection set) with no warning.',
  );
}

// EXPLICIT `WORKER_ROLE=all` in production (gap-closure pass — see
// docs/CACHING_QUEUES_AUDIT.md §0.8.10): the check above only catches an
// UNSET value — an operator who explicitly typed `all` got zero feedback that
// they've chosen the unsplit, monolithic worker (shared DB pool sized for
// combined concurrency, every processor and infra cron in one process) rather
// than the `critical`/`dispatch` split this whole role mechanism exists for.
// `all` is a legitimate, supported choice for a small deployment — this is a
// WARNING, not a hard failure, so it doesn't block a deployment that
// genuinely doesn't need the split; it just makes the choice visible in logs
// rather than silent.
if (
  process.env.NODE_ENV === 'production' &&
  process.env.WORKER_ROLE === 'all'
) {
  new Logger('WorkerModule').warn(
    '⚠️  WORKER_ROLE=all in production — running the UNSPLIT worker (every processor + cron in one ' +
      'process, one shared DB pool). This is fine for a small deployment, but if you meant to isolate the ' +
      'campaign recipient-dispatch hot path from everything else, set WORKER_ROLE=critical/dispatch on two ' +
      'separate deployments instead. See docs/CACHING_QUEUES_AUDIT.md §0.3/§0.5.',
  );
}

const WORKER_ROLE = resolveWorkerRole();

const DISPATCH_PROCESSORS = [CampaignDispatchProcessor];

const CRITICAL_PROCESSORS = [
  NotificationsProcessor,
  WhatsappProcessor,
  // Inbound Meta events + media, on their own queues so neither can stall
  // outbound sends (see QUEUE.WHATSAPP_WEBHOOK / WHATSAPP_MEDIA).
  WhatsappWebhookProcessor,
  WhatsappMediaProcessor,
  CampaignLaunchProcessor,
  CampaignFanoutProcessor,
  CampaignDlqRecoveryProcessor,
  AiProcessor,
  AnalyticsProcessor,
  SettlementsProcessor,
  SubscriptionsProcessor,
  RefundsProcessor,
  PaymentsProcessor,
  PlatformProcessor,
  EmailProcessor,
  UsageReportProcessor,
  WorkflowProcessor,
  WebhookDeliveryProcessor,
  IntegrationImportProcessor,
  IntegrationSyncProcessor,
  IntegrationInboundProcessor,
  IntegrationRecoveryProcessor,
];

const CRITICAL_INFRA = [
  WorkerTenantsService,
  QueueMonitorService,
  ScheduleRegistrarService,
  OutboxRelayService,
  // SES bounce/complaint (SQS long-poll). Idle unless SES_FEEDBACK_QUEUE_URL is
  // set; never in a dispatch-only deployment.
  SesFeedbackConsumer,
];

const WORKER_PROVIDERS =
  WORKER_ROLE === 'dispatch'
    ? DISPATCH_PROCESSORS
    : WORKER_ROLE === 'critical'
      ? [...CRITICAL_INFRA, ...CRITICAL_PROCESSORS]
      : [...CRITICAL_INFRA, ...CRITICAL_PROCESSORS, ...DISPATCH_PROCESSORS]; // 'all' — unchanged from pre-Phase-0

/**
 * The BACKGROUND WORKER application root (bootstrapped by `worker.ts`).
 *
 * This is a separate process root from AppModule: it contains the BullMQ
 * `@Processor` classes (consumers) — so workers run ONLY here, never in the HTTP
 * API. It imports the same DB + tenant-context + queue infrastructure and the
 * domain modules whose services the processors call, but NOT the HTTP guards,
 * controllers' auth, or the seeder. Stateless and horizontally scalable.
 *
 * Domain module `imports` stay UNCONDITIONAL across all three roles (trimming
 * them per-role was considered and rejected — the saving would be a handful of
 * unused service instances at boot, not DB/Redis connections, and it risks
 * subtle cross-module DI breakage for a marginal gain). What's conditional is
 * `providers`: only registering a `@Processor` for the queues this role
 * actually consumes.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      cache: true,
      validate,
    }),
    // Several reused services (e.g. SubscriptionService) inject EventEmitter2.
    // The API root registers this; the worker root must too, or DI fails at
    // boot — discovered by actually starting the worker process, not `tsc`.
    EventEmitterModule.forRoot({ global: true, wildcard: false }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService) =>
        typeOrmFactory(config, 'worker', metrics),
    }),
    // RefreshToken + PasswordReset back AuthTokenMaintenanceService (AUTH-005),
    // the retention sweep PlatformProcessor runs. Registered here rather than
    // by importing AuthModule: the sweep needs two repositories and
    // ConfigService, whereas AuthModule would drag the HTTP controllers,
    // guards, SubscriptionBillingModule and PlatformModule into the worker
    // root for no benefit.
    TypeOrmModule.forFeature([
      Tenant,
      Subscription,
      OutboxJob,
      User,
      RefreshToken,
      PasswordReset,
    ]),
    TenantContextModule,
    // `@Global()` in AppModule, same as TenantContextModule above — but that
    // only makes it ambient within AppModule's own tree. WorkerModule is a
    // separate application root (bootstrapped via `createApplicationContext`,
    // not AppModule), so it must import this explicitly too, or any consumer
    // reached from here (e.g. AdvancedAnalyticsService via AnalyticsModule)
    // fails to resolve BranchScopeService at boot.
    BranchScopeModule,
    // Sibling scope authority, same reasoning as BranchScopeModule immediately
    // above: `@Global()` in AppModule only makes it ambient there. Needed here
    // because AppointmentsService and PatientQueueService (reached via
    // PatientQueueModule/AppointmentModule below) both inject StaffScopeService
    // directly — without this, the worker root fails to resolve it at boot.
    StaffScopeModule,
    // Workers decrypt tenant provider credentials on the send path, so the
    // worker root needs this exactly as much as the API root does.
    CryptoModule,
    QueueModule,
    MetricsModule,
    // Operational log lines for committed business transitions (LOGGING.md).
    ObservabilityEventsModule,

    SchemaGuardModule,
    // `QueueModule` only calls `BullModule.forRootAsync` (shared config, no
    // per-queue registration — see its docstring). That alone never activates
    // `@nestjs/bullmq`'s `BullRegistrar`/`BullExplorer`: those are provided by
    // `BullModule`'s internal `coreModuleDefinition`, which is ONLY pulled in
    // by `registerQueue`/`registerQueueAsync`. Without it, `@Processor`-decorated
    // classes instantiate fine (plain DI) but NEVER become real BullMQ `Worker`s
    // — no `onModuleInit` ever runs `registerWorkers()`, so no job is ever
    // dequeued, regardless of Redis health. Confirmed by instrumenting
    // `BullExplorer.registerWorkers` directly: it was never invoked.
    // Fix: explicitly register every queue name here (worker process only —
    // the API's `QueueModule` import stays untouched, so producers keep using
    // `ProducerQueues`'s own connections, unaffected). Same shared blocking
    // connection factory the module doc already describes as the intended design.
    //
    // Registers ONLY `queuesForRole(WORKER_ROLE)` — under the default `all`
    // role that's every queue (unchanged behaviour); under a split deployment
    // each process only opens BullMQ connections for queues it actually
    // consumes, which is the other half of the Phase 0 connection-count fix
    // (see docs/CACHING_QUEUES_AUDIT.md §0.4 — each registered queue is its
    // own ioredis connection regardless of whether a processor exists for it).
    BullModule.registerQueueAsync(
      ...queuesForRole(WORKER_ROLE).map((name) => ({
        name,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: blockingConnectionOptions(config),
          prefix: bullPrefix(),
        }),
      })),
    ),
    NotificationsModule,
    WhatsappModule,
    CampaignsModule,
    AiModule,
    AnalyticsModule,
    PaymentsModule,
    PlatformModule,
    // T082 (spec 014, US5) — SubscriptionsProcessor's `renewalBill` branch
    // needs RenewalService (and, transitively, the SAME `PAYMENT_PROVIDER`
    // production-safety binding BillingService already depends on — the
    // real charge happens in THIS process, so the worker must resolve the
    // identical factory, not a re-declared copy of it).
    SubscriptionBillingModule,
    EmailModule,
    PlatformUsageModule,
    AiMemoryModule,
    WorkflowModule,
    // Phase 4 — async import + sync processors reuse the shared write pipeline.
    IntegrationPlatformModule,
    DocumentsModule,
    // T095 (spec 014, US12) — AnalyticsProcessor uploads rendered invoice PDFs.
    StorageModule,
    // T160 (spec 014, US9) — PlatformProcessor's waitlistEvaluate/
    // waitlistExpiry branches.
    WaitlistModule,
    // T174 (spec 014, US10) — PlatformProcessor's queueDayClose branch.
    PatientQueueModule,
    // T183 (spec 014, US13) — AnalyticsProcessor's exportGenerate branch and
    // PlatformProcessor's exportExpiry branch.
    ReportExportModule,
    // REL-005 — PaymentOutcomeService. Importing these two also registers their
    // `@OnEvent` entitlement listeners in the worker, which closes a gap that
    // predates the outbox: `payments.reconcile` runs HERE and emits
    // `payment.succeeded` for a payment it recovers, but neither listener was
    // loaded in this process, so a reconciled add-on / billing-upgrade payment
    // never granted its entitlement.
    AppointmentModule,
    BillingUpgradeModule,
    ResourcePricingModule,
  ],
  providers: [
    AuthTokenMaintenanceService,
    FreeAccessNoticeService,
    PaymentOutcomeService,
    ...WORKER_PROVIDERS,
  ],
})
export class WorkerModule {}

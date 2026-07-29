import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { typeOrmFactory } from './config/typeorm.config';
import { validate } from './config/env.validation';

import { Tenant } from './entities/SaaS-Core/Tenant';
import { Subscription } from './entities/SaaS-Core/Subscription';
import { OutboxJob } from './entities/Campaigns/OutboxJob';

import { TenantContextModule } from './core/tenant-context/tenant-context.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { QueueModule } from './queue/queue.module';
import { resolveWorkerRole, queuesForRole } from './queue/queue.constants';
import { blockingConnectionOptions } from './queue/redis.config';

// Domain modules whose EXISTING services the processors reuse (no logic copied).
import { NotificationsModule } from './modules/notifications/notifications.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { AiModule } from './modules/ai/ai.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PlatformModule } from './modules/platform/platform.module';
import { EmailModule } from './modules/email/email.module';

import { WorkerTenantsService } from './worker/worker-tenants.service';
import { QueueMonitorService } from './worker/queue-monitor.service';
import { ScheduleRegistrarService } from './worker/schedule-registrar.service';
import { OutboxRelayService } from './worker/outbox-relay.service';

import { NotificationsProcessor } from './worker/processors/notifications.processor';
import { WhatsappProcessor } from './worker/processors/whatsapp.processor';
import { WhatsappWebhookProcessor } from './worker/processors/whatsapp-webhook.processor';
import { WhatsappMediaProcessor } from './worker/processors/whatsapp-media.processor';
import {
  CampaignLaunchProcessor,
  CampaignFanoutProcessor,
  CampaignDispatchProcessor,
} from './worker/processors/campaigns.processor';
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
import { IntegrationImportProcessor } from './worker/processors/integration-import.processor';
import { IntegrationSyncProcessor } from './worker/processors/integration-sync.processor';
import { IntegrationInboundProcessor } from './worker/processors/integration-inbound.processor';

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
];

const CRITICAL_INFRA = [WorkerTenantsService, QueueMonitorService, ScheduleRegistrarService, OutboxRelayService];

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
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', cache: true, validate }),
    // Several reused services (e.g. SubscriptionService) inject EventEmitter2.
    // The API root registers this; the worker root must too, or DI fails at
    // boot — discovered by actually starting the worker process, not `tsc`.
    EventEmitterModule.forRoot({ global: true, wildcard: false }),
    TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: typeOrmFactory }),
    TypeOrmModule.forFeature([Tenant, Subscription, OutboxJob]),
    TenantContextModule,
    // Workers decrypt tenant provider credentials on the send path, so the
    // worker root needs this exactly as much as the API root does.
    CryptoModule,
    QueueModule,
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
    EmailModule,
    PlatformUsageModule,
    AiMemoryModule,
    WorkflowModule,
    // Phase 4 — async import + sync processors reuse the shared write pipeline.
    IntegrationPlatformModule,
  ],
  providers: WORKER_PROVIDERS,
})
export class WorkerModule {}

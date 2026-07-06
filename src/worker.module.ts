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
import { QueueModule } from './queue/queue.module';
import { ALL_QUEUES } from './queue/queue.constants';
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
import { PlatformProcessor } from './worker/processors/platform.processor';
import { EmailProcessor } from './worker/processors/email.processor';
import { UsageReportProcessor } from './worker/processors/usage-report.processor';
import { PlatformUsageModule } from './modules/platform-usage/platform-usage.module';
import { AiMemoryModule } from './modules/ai-memory/ai-memory.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { WorkflowProcessor } from './worker/processors/workflow.processor';

/**
 * The BACKGROUND WORKER application root (bootstrapped by `worker.ts`).
 *
 * This is a separate process root from AppModule: it contains the BullMQ
 * `@Processor` classes (consumers) — so workers run ONLY here, never in the HTTP
 * API. It imports the same DB + tenant-context + queue infrastructure and the
 * domain modules whose services the processors call, but NOT the HTTP guards,
 * controllers' auth, or the seeder. Stateless and horizontally scalable.
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
    BullModule.registerQueueAsync(
      ...ALL_QUEUES.map((name) => ({
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
  ],
  providers: [
    WorkerTenantsService,
    QueueMonitorService,
    ScheduleRegistrarService,
    OutboxRelayService,
    NotificationsProcessor,
    WhatsappProcessor,
    CampaignLaunchProcessor,
    CampaignFanoutProcessor,
    CampaignDispatchProcessor,
    AiProcessor,
    AnalyticsProcessor,
    SettlementsProcessor,
    SubscriptionsProcessor,
    RefundsProcessor,
    PlatformProcessor,
    EmailProcessor,
    UsageReportProcessor,
    WorkflowProcessor,
  ],
})
export class WorkerModule {}

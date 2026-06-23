import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { blockingConnectionOptions } from './redis.config';
import { defaultJobOptions } from './queue.constants';
import { QueueService } from './queue.service';
import { ProducerQueues } from './producer-queues';
import { TenantRateLimiterService } from './tenant-rate-limiter.service';

/**
 * Centralized background-job infrastructure with THREE separated Redis roles.
 *
 *  1. WORKERS — `BullModule.forRootAsync` sets the shared default connection to
 *     the BLOCKING profile. The @nestjs/bullmq explorer derives every
 *     `@Processor`'s `Worker` connection from this shared config (its fallback
 *     when a queue isn't separately registered), so all workers get a blocking
 *     connection with no per-processor wiring. Workers exist ONLY in
 *     WorkerModule, so the API never consumes.
 *  2. PRODUCERS — enqueues go through `ProducerQueues`: dedicated `Queue`
 *     instances on the PRODUCER profile (own sockets, offline-queue buffering).
 *     We intentionally do NOT use `BullModule.registerQueue` for producing,
 *     because the explorer would couple that connection to the workers.
 *  3. QUEUEEVENTS — created in QueueMonitorService on the EVENTS profile (its
 *     own connection instance).
 *
 * `@Global` so any service can inject `QueueService` / `TenantRateLimiterService`
 * without importing this module. Imported by BOTH roots: AppModule (API →
 * enqueue) and WorkerModule (worker → consume + fan-out enqueue).
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Shared default = WORKER (blocking) profile. The explorer hands this to
        // every @Processor's Worker. Producers use ProducerQueues instead.
        connection: blockingConnectionOptions(config),
        defaultJobOptions: defaultJobOptions(config),
      }),
    }),
  ],
  providers: [QueueService, ProducerQueues, TenantRateLimiterService],
  exports: [QueueService, ProducerQueues, TenantRateLimiterService, BullModule],
})
export class QueueModule {}

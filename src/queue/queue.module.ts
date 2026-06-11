import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { redisConnectionOptions } from './redis.config';
import { ALL_QUEUES, defaultJobOptions } from './queue.constants';
import { QueueService } from './queue.service';

/**
 * Centralized background-job infrastructure (PRODUCER side).
 *
 * `@Global` so any service can inject `QueueService` to enqueue without
 * importing this module. It wires the single shared Redis connection (from
 * REDIS_URL only) and REGISTERS all queues — registering a queue creates a
 * producer (`Queue`), it does NOT start a worker. Workers live exclusively in
 * the separate WorkerModule (worker.ts), so the HTTP API never consumes jobs.
 *
 * Imported by BOTH process roots: AppModule (API → enqueue) and WorkerModule
 * (worker → also enqueues fan-out jobs).
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionOptions(config),
        defaultJobOptions: defaultJobOptions(config),
      }),
    }),
    ...ALL_QUEUES.map((name) => BullModule.registerQueue({ name })),
  ],
  providers: [QueueService],
  exports: [QueueService, BullModule],
})
export class QueueModule {}

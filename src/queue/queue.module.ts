import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';

import { blockingConnectionOptions } from './redis.config';
import { defaultJobOptions } from './queue.constants';
import { QueueService } from './queue.service';
import { ProducerQueues } from './producer-queues';
import { TenantRateLimiterService } from './tenant-rate-limiter.service';
import { AppRedisService } from './app-redis.service';
import { FixedWindowLimiterService } from './fixed-window-limiter.service';
import { WorkerAuthorizationService } from './worker-authorization.service';
import { SubscriptionBillingModule } from '../modules/subscription-billing/subscription-billing.module';
import { DistributedLockService } from './distributed-lock.service';
import { AuthModule } from '../modules/auth/auth.module';
import { User } from '../entities/Auth&RBAC/User';

/**
 * Centralized background-job infrastructure with SIX separated Redis roles
 * (expanded from three — see docs/CACHING_QUEUES_AUDIT.md §0.5 for why).
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
 *  4. APPLICATION — `AppRedisService.application`: plain KV/health-check
 *     commands (kvGet/kvSet/redisPing). Fail-fast (`commandTimeout`), unlike
 *     roles 1-3 which must never time out mid-blocking-wait.
 *  5. RATE LIMITER — `AppRedisService.rateLimiter`: the tenant/API-key token
 *     bucket Lua script. Also fail-fast, for the same reason as role 4.
 *  6. CACHE — `AnalyticsCacheService`'s own dedicated client (built directly
 *     from `cacheConnectionOptions`, not routed through this module since it's
 *     scoped to one service). Also fail-fast.
 *
 * Roles 4-5 exist specifically because the "fail open on Redis error" call
 * sites (ApiKeyAuthGuard, the OAuth refresh lock, kvGet/kvSet) used to silently
 * ride the PRODUCER connection and inherit its slow-to-fail buffering — see
 * the original audit's C2 finding. `commandTimeout` is intentionally NEVER set
 * on roles 1-3: BullMQ's blocking commands and lock-renewal timers must not
 * race an application-level timeout (see redis.config.ts for the long-form
 * rationale on each function).
 *
 * `@Global` so any service can inject `QueueService` / `TenantRateLimiterService`
 * / `AppRedisService` without importing this module. Imported by BOTH roots:
 * AppModule (API → enqueue) and WorkerModule (worker → consume + fan-out enqueue).
 */
@Global()
@Module({
  imports: [
    // WorkerAuthorizationService needs its own User repository for
    // existence/active/tenant-membership checks, and — for the ONE job type
    // that declares a `requiredPermission` (gap-closure pass, see
    // docs/CACHING_QUEUES_AUDIT.md §0.8.10) — AuthModule's AuthService to
    // reuse the SAME permission-resolution logic HTTP guards use, rather than
    // reimplementing a second RBAC join.
    TypeOrmModule.forFeature([User]),
    AuthModule,
    // Entitlement for tenant-scoped jobs. Background work must reach the SAME
    // decision the HTTP route would, and the only way to guarantee that is to
    // call the same service rather than re-derive it worker-side. Safe to
    // import: SubscriptionBillingModule does not import QueueModule (it is
    // @Global, so nothing needs to), leaving no cycle.
    SubscriptionBillingModule,
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
  providers: [
    QueueService,
    ProducerQueues,
    TenantRateLimiterService,
    AppRedisService,
    WorkerAuthorizationService,
    DistributedLockService,
    FixedWindowLimiterService,
  ],
  exports: [
    QueueService,
    ProducerQueues,
    TenantRateLimiterService,
    AppRedisService,
    WorkerAuthorizationService,
    DistributedLockService,
    BullModule,
    FixedWindowLimiterService,
  ],
})
export class QueueModule {}

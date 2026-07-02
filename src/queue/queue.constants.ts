import { ConfigService } from '@nestjs/config';
import { DefaultJobOptions } from 'bullmq';

/** Standardized queue names. Campaigns are split by stage for isolation. */
export const QUEUE = {
  NOTIFICATIONS: 'notifications',
  NOTIFICATIONS_DLQ: 'notifications.dlq',
  WHATSAPP: 'whatsapp',
  // Campaign execution pipeline (stage-isolated queues).
  CAMPAIGNS_LAUNCH: 'campaigns.launch',
  CAMPAIGNS_FANOUT: 'campaigns.fanout',
  CAMPAIGNS_PROCESS: 'campaigns.processRecipient',
  CAMPAIGNS_DLQ: 'campaigns.dlq',
  AI: 'ai',
  ANALYTICS: 'analytics',
  SETTLEMENTS: 'settlements',
  SUBSCRIPTIONS: 'subscriptions',
  REFUNDS: 'refunds',
  PLATFORM: 'platform',
  EMAIL: 'email',
  USAGE_REPORT: 'usage-report',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);

/** The campaign pipeline queues (used for monitoring/depth helpers). */
export const CAMPAIGN_QUEUES: QueueName[] = [
  QUEUE.CAMPAIGNS_LAUNCH,
  QUEUE.CAMPAIGNS_FANOUT,
  QUEUE.CAMPAIGNS_PROCESS,
  QUEUE.CAMPAIGNS_DLQ,
];

/** Standardized job names — `<domain>.<action>`. */
export const JOB = {
  NOTIFICATIONS_DISPATCH: 'notifications.dispatch',
  NOTIFICATIONS_REAP: 'notifications.reap',
  NOTIFICATIONS_DLQ: 'notifications.dlq',
  WHATSAPP_SEND: 'whatsapp.send',
  WHATSAPP_RETRY: 'whatsapp.retry',
  CAMPAIGNS_LAUNCH: 'campaigns.launch',
  CAMPAIGNS_FANOUT_CHUNK: 'campaigns.fanoutChunk',
  CAMPAIGNS_PROCESS_RECIPIENT: 'campaigns.processRecipient',
  CAMPAIGNS_DLQ: 'campaigns.dlq',
  AI_EXECUTE: 'ai.execute',
  ANALYTICS_AGGREGATE: 'analytics.aggregate',
  ANALYTICS_GENERATE_REPORT: 'analytics.generateReport',
  ANALYTICS_CLEANUP: 'analytics.cleanup',
  SETTLEMENTS_PROCESS: 'settlements.process',
  SUBSCRIPTIONS_RENEWAL_CHECK: 'subscriptions.renewalCheck',
  REFUNDS_REAP: 'refunds.reap',
  PLATFORM_LOG_CLEANUP: 'platform.logCleanup',
  EMAIL_SEND: 'email.send',
  USAGE_REPORT_TICK: 'usageReport.tick',
  USAGE_REPORT_RUN: 'usageReport.run',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * Production-safe default job options: configurable attempts + exponential
 * backoff, completed jobs trimmed (age + count cap). FAILED jobs are retained
 * (`removeOnFail: false`) because the processor explicitly routes exhausted
 * TRANSIENT failures into the dedicated DLQ — we never want them silently
 * evicted before that handler runs.
 */
export function defaultJobOptions(config: ConfigService): DefaultJobOptions {
  return {
    attempts: config.get<number>('QUEUE_DEFAULT_ATTEMPTS', 5) ?? 5,
    backoff: {
      type: 'exponential',
      delay: config.get<number>('QUEUE_BACKOFF_MS', 3000) ?? 3000,
    },
    removeOnComplete: { age: 3600, count: 1000 },
    // Cap failed-job retention so the failed set can't grow unbounded in Redis.
    // The processors route exhausted failures to the DLQ in their `failed`
    // handler (which fires before eviction), so a 7-day window is ample for
    // inspection without leaking memory at millions/day.
    removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
  };
}

/** Worker concurrency per process (read at decoration time in the worker app). */
export function workerConcurrency(): number {
  const n = Number(process.env.WORKER_CONCURRENCY ?? '5');
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** Higher concurrency for the recipient-send queue (the hot path). */
export function dispatchConcurrency(): number {
  const n = Number(process.env.CAMPAIGN_DISPATCH_CONCURRENCY ?? '25');
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * GLOBAL provider-protection limiter for the recipient-send queue. Caps total
 * throughput to the channel provider across all tenants/pods sharing this Redis.
 * Per-tenant fairness is enforced separately by the Redis token bucket.
 */
export function dispatchLimiter(): { max: number; duration: number } {
  const max = Number(process.env.CAMPAIGN_GLOBAL_MAX_PER_SEC ?? '1000');
  return { max: Number.isFinite(max) && max > 0 ? max : 1000, duration: 1000 };
}

/**
 * Exponential backoff WITH jitter — avoids a thundering herd when a provider
 * recovers and many jobs retry at the same instant. Registered on the worker as
 * a custom backoff strategy under the name `expo-jitter`.
 */
export const BACKOFF_EXPO_JITTER = 'expo-jitter';
export function expoJitterBackoff(attemptsMade: number): number {
  const base = Number(process.env.QUEUE_BACKOFF_MS ?? '3000');
  const max = Number(process.env.QUEUE_BACKOFF_MAX_MS ?? '60000');
  const exp = Math.min(base * 2 ** (attemptsMade - 1), max);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

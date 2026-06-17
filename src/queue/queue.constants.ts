import { ConfigService } from '@nestjs/config';
import { DefaultJobOptions } from 'bullmq';

/** Standardized queue names (one BullMQ queue per domain). */
export const QUEUE = {
  NOTIFICATIONS: 'notifications',
  WHATSAPP: 'whatsapp',
  CAMPAIGNS: 'campaigns',
  AI: 'ai',
  ANALYTICS: 'analytics',
  SETTLEMENTS: 'settlements',
  SUBSCRIPTIONS: 'subscriptions',
  REFUNDS: 'refunds',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);

/** Standardized job names — `<domain>.<action>`. */
export const JOB = {
  NOTIFICATIONS_DISPATCH: 'notifications.dispatch',
  WHATSAPP_SEND: 'whatsapp.send',
  WHATSAPP_RETRY: 'whatsapp.retry',
  CAMPAIGNS_PROCESS_RECIPIENT: 'campaigns.processRecipient',
  CAMPAIGNS_LAUNCH: 'campaigns.launch',
  AI_EXECUTE: 'ai.execute',
  ANALYTICS_AGGREGATE: 'analytics.aggregate',
  ANALYTICS_GENERATE_REPORT: 'analytics.generateReport',
  SETTLEMENTS_PROCESS: 'settlements.process',
  SUBSCRIPTIONS_RENEWAL_CHECK: 'subscriptions.renewalCheck',
  REFUNDS_REAP: 'refunds.reap',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * Production-safe default job options: configurable attempts + exponential
 * backoff, completed jobs trimmed (age + count cap), and FAILED jobs retained
 * for a week so the BullMQ "failed set" doubles as a monitorable dead-letter
 * store (see QueueMonitorService).
 */
export function defaultJobOptions(config: ConfigService): DefaultJobOptions {
  return {
    attempts: config.get<number>('QUEUE_DEFAULT_ATTEMPTS', 5) ?? 5,
    backoff: {
      type: 'exponential',
      delay: config.get<number>('QUEUE_BACKOFF_MS', 3000) ?? 3000,
    },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
}

/** Worker concurrency per process (read at decoration time in the worker app). */
export function workerConcurrency(): number {
  const n = Number(process.env.WORKER_CONCURRENCY ?? '5');
  return Number.isFinite(n) && n > 0 ? n : 5;
}

import { UnrecoverableError } from 'bullmq';

/**
 * Retry-classification errors for the notification dispatch pipeline.
 *  - TransientNotificationError → normal Error → BullMQ retries with backoff;
 *    exhausted attempts are routed to the DLQ.
 *  - PermanentNotificationError extends UnrecoverableError → fails immediately,
 *    no retry, no DLQ (business/permanent fault, not a system fault).
 */
export class TransientNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientNotificationError';
  }
}

export class PermanentNotificationError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentNotificationError';
  }
}

import { UnrecoverableError } from 'bullmq';

/**
 * Retry-classification errors thrown by the dispatch pipeline.
 *
 *  - {@link TransientDispatchError} is a normal Error → BullMQ retries it with
 *    backoff; once attempts are exhausted the processor routes it to the DLQ.
 *  - {@link PermanentDispatchError} extends BullMQ's `UnrecoverableError` → the
 *    job fails immediately with NO retry and NO DLQ (it's a business/permanent
 *    fault, not a system fault).
 */
export class TransientDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientDispatchError';
  }
}

export class PermanentDispatchError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDispatchError';
  }
}

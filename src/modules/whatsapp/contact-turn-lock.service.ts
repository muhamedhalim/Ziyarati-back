import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { DistributedLockService } from '../../queue/distributed-lock.service';

/** Timings, in ms. A public field on the service so a test can shrink them. */
export interface ContactTurnLockTimings {
  /** How long a held lock survives without a renewal (a crashed holder frees it by itself). */
  ttlMs: number;
  /** How often a live holder extends it. Well under `ttlMs`, so one missed beat is survivable. */
  renewMs: number;
  /** The longest a waiting turn queues for the lock before giving up. */
  waitMs: number;
  /** Poll interval while waiting. */
  pollMs: number;
}

export const CONTACT_TURN_LOCK_TIMINGS: ContactTurnLockTimings = {
  ttlMs: 60_000,
  renewMs: 20_000,
  waitMs: 20_000,
  pollMs: 250,
};

/**
 * Thrown when another turn for the same contact still holds the lock after
 * {@link ContactTurnLockTimings.waitMs}. NOT a failure of the turn: nothing has
 * been run or sent, so the caller must let the job fail and be retried (BullMQ
 * backoff), never answer the patient with an apology.
 */
export class ContactTurnBusyError extends Error {
  constructor() {
    super('Another AI turn for this contact is still running');
    this.name = 'ContactTurnBusyError';
  }
}

/**
 * Serializes AI turns per (clinic, contact).
 *
 * Without it, two messages from one patient picked up by two workers run at
 * once: neither turn sees the other's message or reply in its history, replies
 * can leave out of order, and a retry of a turn can overlap its own earlier
 * attempt. The webhook worker runs with concurrency > 1, and the per-contact
 * rate limiter counts attempts — it is not a mutex.
 *
 * The lock is held for the WHOLE turn (model call through the WhatsApp send) and
 * renewed while it runs, so a slow turn does not lose it; a crashed holder
 * releases it by TTL. It is an ordering aid, not the correctness guarantee:
 * double-processing is still prevented by the AI request claim (keyed on the
 * `wamid`) and the send de-duplication, so losing the lock degrades ordering,
 * not safety.
 *
 * The contact is hashed in the key: a phone number is not written into Redis.
 */
@Injectable()
export class ContactTurnLockService {
  private readonly logger = new Logger('ContactTurnLockService');

  timings: ContactTurnLockTimings = { ...CONTACT_TURN_LOCK_TIMINGS };

  constructor(private readonly locks: DistributedLockService) {}

  /**
   * Runs `fn` while holding the contact's lock. `fn` is told whether this turn
   * had to queue behind another, because such a turn must re-check its
   * preconditions: the world may have changed while it waited.
   */
  async run<T>(
    tenantId: string,
    waId: string,
    fn: (info: { waited: boolean }) => Promise<T>,
  ): Promise<T> {
    const key = this.keyFor(tenantId, waId);
    const { ttlMs, renewMs, waitMs, pollMs } = this.timings;
    const startedAt = Date.now();

    let token: string | null = null;
    let waited = false;
    for (;;) {
      token = await this.locks.acquire(key, ttlMs);
      if (token) break;
      waited = true;
      if (Date.now() - startedAt >= waitMs) throw new ContactTurnBusyError();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    let lostWarned = false;
    const heartbeat = setInterval(() => {
      void this.locks.renew(key, token as string, ttlMs).then((ok) => {
        if (!ok && !lostWarned) {
          lostWarned = true;
          this.logger.warn(
            `contact turn lock was lost mid-turn (tenant=${tenantId}) — the turn continues; ` +
              `the AI request claim still prevents double processing`,
          );
        }
      });
    }, renewMs);
    heartbeat.unref();

    try {
      return await fn({ waited });
    } finally {
      clearInterval(heartbeat);
      await this.locks.release(key, token);
    }
  }

  private keyFor(tenantId: string, waId: string): string {
    const contact = createHash('sha256')
      .update(waId)
      .digest('hex')
      .slice(0, 32);
    return `wa-ai:turn:${tenantId}:${contact}`;
  }
}

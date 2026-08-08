import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { QueueService } from '../../queue/queue.service';

import {
  SUPPORT_VISIBLE_QUEUES,
  SUPPORT_WORKER_HEARTBEAT_KEY,
  SUPPORT_WORKER_HEARTBEAT_STALE_SECONDS,
} from './platform-support.constants';

type WorkerState = 'running' | 'degraded' | 'offline' | 'unknown';

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Queue and worker HEALTH for Platform Customer Service.
 *
 * The distinction this service exists to preserve: Support needs to answer
 * "is delivery working right now?", not to administer Redis. So it returns
 * counts, timestamps and a derived state — and there is deliberately no
 * endpoint, anywhere in this module, to pause, resume, drain, clean, delete or
 * bulk-retry a queue, and no way to read a job payload (job data routinely
 * carries recipient addresses and rendered content).
 *
 * Never returned: the Redis connection string, any Redis key, any job payload,
 * or the full platform monitoring snapshot (which additionally carries memory,
 * CPU, slow endpoints and storage figures Support has no need for).
 *
 * The queue list is an allow-list (`SUPPORT_VISIBLE_QUEUES`) rather than
 * "everything `queueCounts()` returns", so a future internal queue does not
 * become visible to Support merely by being registered.
 */
@Injectable()
export class SupportJobsService {
  private readonly logger = new Logger(SupportJobsService.name);

  constructor(
    private readonly queues: QueueService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Platform-wide (not per-clinic) delivery infrastructure health.
   *
   * Queues are a shared resource — a stalled email worker affects every
   * clinic — so this is deliberately NOT tenant-scoped. It carries no tenant
   * data at all, only counts and states, which is what makes that safe.
   */
  async health() {
    const [redis, worker, queues, oldestEmail] = await Promise.all([
      this.redisHealth(),
      this.workerHealth(),
      this.queueCounts(),
      this.oldestPendingEmailAgeSeconds(),
    ]);

    return {
      redis,
      worker,
      queues,
      email: {
        // The one cross-cutting signal that reliably distinguishes "the worker
        // is down" from "nothing has been sent lately": a job sitting in
        // `email_logs` as QUEUED long after it was created means it was
        // enqueued but never consumed.
        oldestPendingSeconds: oldestEmail,
      },
      collectedAt: new Date().toISOString(),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async redisHealth() {
    try {
      const latencyMs = await this.queues.redisPing();
      return { status: 'up' as const, latencyMs };
    } catch {
      // The connection string is never included in the response — a failed
      // ping tells Support what they need ("the queue backend is unreachable")
      // without disclosing where it lives.
      return { status: 'down' as const, latencyMs: null };
    }
  }

  /**
   * Worker liveness via the shared heartbeat key. `unknown` (no heartbeat at
   * all) is reported distinctly from `offline`: on a fresh deployment the key
   * simply may not exist yet, and telling a support agent "offline" in that
   * case would send them chasing a non-incident.
   */
  private async workerHealth() {
    try {
      const raw = await this.queues.kvGet(SUPPORT_WORKER_HEARTBEAT_KEY);
      if (!raw) {
        return { state: 'unknown' as WorkerState, heartbeatAgeSeconds: null };
      }
      const parsed = JSON.parse(raw) as { at: string };
      const ageSeconds = Math.round((Date.now() - new Date(parsed.at).getTime()) / 1000);
      const state: WorkerState =
        ageSeconds < SUPPORT_WORKER_HEARTBEAT_STALE_SECONDS ? 'running' : 'degraded';
      return { state, heartbeatAgeSeconds: ageSeconds };
    } catch (err) {
      this.logger.warn(`Worker heartbeat unreadable: ${(err as Error)?.message}`);
      return { state: 'unknown' as WorkerState, heartbeatAgeSeconds: null };
    }
  }

  /**
   * Depth per visible queue. A failed `queueCounts()` degrades to an explicit
   * `unavailable` marker rather than zeros — reporting "0 waiting" when the
   * backend is unreachable would be an actively misleading diagnosis.
   */
  private async queueCounts() {
    let counts: Record<string, Record<string, number>> = {};
    let available = true;
    try {
      counts = await this.queues.queueCounts();
    } catch {
      available = false;
    }

    return SUPPORT_VISIBLE_QUEUES.map((name) => {
      const c = counts[name];
      if (!available || !c) {
        return {
          name,
          available: false,
          waiting: null,
          active: null,
          delayed: null,
          failed: null,
        };
      }
      return {
        name,
        available: true,
        waiting: int(c.waiting),
        active: int(c.active),
        delayed: int(c.delayed),
        failed: int(c.failed),
        // `completed` is deliberately omitted: it is a retention artefact
        // (BullMQ prunes it on an age/count policy), so exposing it invites
        // "why did the completed count drop?" questions with no real answer.
      };
    });
  }

  /**
   * Age of the oldest `email_logs` row still sitting at QUEUED. Read from the
   * database rather than from Redis so it survives a queue flush, and because
   * it is the signal that actually correlates with a clinic's complaint.
   */
  private async oldestPendingEmailAgeSeconds(): Promise<number | null> {
    try {
      const [row] = await this.dataSource.query(
        `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS age
           FROM email_logs WHERE status = 'QUEUED'`,
      );
      return row?.age == null ? null : int(row.age);
    } catch (err) {
      this.logger.warn(`Oldest-pending-email probe failed: ${(err as Error)?.message}`);
      return null;
    }
  }
}

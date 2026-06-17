import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { QueueService } from '../../queue/queue.service';
import { ReapSummary } from './refund-recovery.service';

const REAPER_HEARTBEAT_KEY = 'payments:reaper:heartbeat';

export interface FinancialMetrics {
  pendingRefunds: { count: number; maxAgeSeconds: number };
  openClawbacks: { count: number; maxAgeSeconds: number };
  negativeSettlements: { count: number };
  /** Last reaper run summary + when it ran (worker liveness). null = never seen. */
  reaper: { lastRunAt: string; summary: ReapSummary } | null;
  /** Seconds since the last reaper heartbeat; null when absent. Stale ⇒ worker down. */
  workerHeartbeatAgeSeconds: number | null;
  collectedAt: string;
}

/**
 * H4 — financial observability. DB-derived gauges are queried live (work from any
 * process); the reaper's run counters + liveness come from a shared-Redis
 * heartbeat the worker writes each sweep. Designed to be scraped by ops/alerting:
 *   - pendingRefunds.maxAgeSeconds > hardFail        → stuck refunds
 *   - openClawbacks.maxAgeSeconds > threshold        → unrecovered clawbacks (H2)
 *   - negativeSettlements.count > 0                  → merchant-owes-back batches
 *   - workerHeartbeatAgeSeconds > 2× reaper interval → worker/Redis down (M5)
 */
@Injectable()
export class FinancialMetricsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: QueueService,
  ) {}

  async collect(): Promise<FinancialMetrics> {
    const pr = await this.dataSource.query(
      `SELECT count(*)::int AS c,
              COALESCE(CEIL(EXTRACT(EPOCH FROM now() - min(created_at))), 0)::int AS max_age
         FROM refunds WHERE status = 'PENDING'`,
    );
    const cb = await this.dataSource.query(
      `SELECT count(*)::int AS c,
              COALESCE(CEIL(EXTRACT(EPOCH FROM now() - min(created_at))), 0)::int AS max_age
         FROM settlement_adjustments WHERE status = 'OPEN'`,
    );
    const ns = await this.dataSource.query(
      `SELECT count(*)::int AS c FROM settlements WHERE net_amount < 0`,
    );

    let reaper: FinancialMetrics['reaper'] = null;
    let workerHeartbeatAgeSeconds: number | null = null;
    const hb = await this.queue.kvGet(REAPER_HEARTBEAT_KEY).catch(() => null);
    if (hb) {
      try {
        const parsed = JSON.parse(hb) as { at: string; summary: ReapSummary };
        reaper = { lastRunAt: parsed.at, summary: parsed.summary };
        workerHeartbeatAgeSeconds = Math.round(
          (Date.now() - new Date(parsed.at).getTime()) / 1000,
        );
      } catch {
        /* malformed heartbeat → treat as absent */
      }
    }

    return {
      pendingRefunds: { count: pr[0].c, maxAgeSeconds: pr[0].max_age },
      openClawbacks: { count: cb[0].c, maxAgeSeconds: cb[0].max_age },
      negativeSettlements: { count: ns[0].c },
      reaper,
      workerHeartbeatAgeSeconds,
      collectedAt: new Date().toISOString(),
    };
  }

  /** Called by the worker after each reaper sweep — doubles as a liveness beat. */
  async recordReaperHeartbeat(summary: ReapSummary): Promise<void> {
    await this.queue
      .kvSet(
        REAPER_HEARTBEAT_KEY,
        JSON.stringify({ at: new Date().toISOString(), summary }),
        3600,
      )
      .catch(() => undefined);
  }
}

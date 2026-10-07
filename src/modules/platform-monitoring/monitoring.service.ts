import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as os from 'node:os';

import { ApiLog } from '../../entities/System/ApiLog';
import { WebhookLog } from '../../entities/System/WebhookLog';
import { QueueService } from '../../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { AnalyticsCacheService, CACHE_NS } from '../analytics/analytics-cache.service';

/**
 * `AnalyticsCacheService.wrap` is per-TENANT by design (the tenant id is
 * baked into every key). This payload has no tenant — it is one platform-
 * global snapshot for every super-admin — so it is cached under this fixed
 * pseudo-tenant id, paired with the dedicated `CACHE_NS.PLATFORM` namespace
 * (never `DASHBOARD`/`DAILY`/`STAFF`) so it can never collide with, or be
 * invalidated by, a real tenant's cache traffic.
 */
const PLATFORM_CACHE_SCOPE = 'platform';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Worker-liveness heartbeat written by the refunds reaper (reused as a proxy). */
const WORKER_HEARTBEAT_KEY = 'payments:reaper:heartbeat';

type ServiceStatus = 'configured' | 'not_configured';
type Health = 'up' | 'down' | 'degraded' | 'unknown';
type AlertLevel = 'critical' | 'warning' | 'healthy';

/**
 * Read-only platform monitoring aggregator for super-admins. Composes existing
 * infrastructure primitives — `QueueService` (Redis/BullMQ), the SQL logs
 * (`api_logs`, `webhook_logs`), `StorageService` (R2), and process/OS metrics —
 * into one dashboard snapshot. It introduces NO new health checks and never
 * mutates state.
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    @InjectRepository(ApiLog) private readonly apiLogs: Repository<ApiLog>,
    @InjectRepository(WebhookLog) private readonly webhookLogs: Repository<WebhookLog>,
    private readonly dataSource: DataSource,
    private readonly queues: QueueService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly cache: AnalyticsCacheService,
  ) {}

  /**
   * ~10 raw SQL statements (system health + traffic + webhooks +
   * infrastructure) per open tab, on a client that polls every 15s (POLL-001)
   * — this collapsed that to one compute per 10s shared across every open
   * tab. `bypassCache` mirrors `PlatformDashboardService.snapshot`'s explicit
   * `Cache-Control: no-cache` escape hatch (`PlatformMonitoringController`),
   * so Refresh always re-runs the aggregation instead of re-serving a value
   * the operator just asked to replace.
   */
  async overview(options?: { bypassCache?: boolean }) {
    if (options?.bypassCache) return this.computeOverview();
    return this.cache.wrap(
      PLATFORM_CACHE_SCOPE,
      CACHE_NS.PLATFORM,
      'overview',
      () => this.computeOverview(),
    );
  }

  private async computeOverview() {
    const [system, traffic, webhooks, queueList] = await Promise.all([
      this.systemHealth(),
      this.traffic(),
      this.webhooks(),
      this.queues.queueCounts().catch(() => ({})),
    ]);

    const queueRows = Object.entries(queueList).map(([name, c]) => ({
      name,
      waiting: n(c.waiting),
      active: n(c.active),
      delayed: n(c.delayed),
      completed: n(c.completed),
      failed: n(c.failed),
    }));
    const activeJobs = queueRows.reduce((s, q) => s + q.active, 0);
    const failedJobs = queueRows.reduce((s, q) => s + q.failed, 0);

    const infrastructure = await this.infrastructure();
    const externalServices = this.externalServices();
    const alerts = this.alerts({ system, failedJobs, traffic, webhooks });

    return {
      system: { ...system, activeJobs, failedJobs },
      traffic,
      infrastructure,
      externalServices,
      queues: queueRows,
      webhooks,
      alerts,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Light health probe for the Platform Control Center's status strip.
   *
   * `overview()` above is deliberately NOT reused for that: it aggregates over
   * the whole `api_logs` table with no WHERE clause, then does a 24-hour
   * `GROUP BY endpoint, method`, then sums verification-document bytes — the
   * heaviest read in the console. Putting it behind the landing page would make
   * the front door the slowest screen in the product.
   *
   * This returns only what a red/amber/green strip can actually show, from
   * primitives that are already cheap: a `SELECT 1`, a Redis `PING`, the BullMQ
   * job counts, and one indexed count over `webhook_logs` (bounded by
   * `IX_webhook_logs_created`). No traffic scan, no storage rollup, no
   * slow-endpoint ranking — those stay on `/platform/monitoring`, which is where
   * an operator goes when the strip tells them to look.
   *
   * @param webhookSince lower bound for the webhook failure count (UTC).
   */
  async healthSnapshot(webhookSince: Date) {
    const [system, queueList, webhookFailures] = await Promise.all([
      this.systemHealth(),
      this.queues.queueCounts().catch(() => ({})),
      this.recentWebhookFailures(webhookSince).catch(() => 0),
    ]);

    let queueBacklog = 0;
    let failedJobs = 0;
    for (const c of Object.values(queueList)) {
      queueBacklog += n(c.waiting) + n(c.active) + n(c.delayed);
      failedJobs += n(c.failed);
    }

    return {
      database: system.database.status,
      redis: system.redis.status,
      workers: system.workers.status,
      workerHeartbeatAgeSeconds: system.workers.heartbeatAgeSeconds,
      queueBacklog,
      failedJobs,
      webhookFailures,
    };
  }

  /** Failed webhook deliveries since `since` — indexed on `created_at`. */
  private async recentWebhookFailures(since: Date): Promise<number> {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM webhook_logs
        WHERE created_at >= $1 AND status ~* 'fail|error'`,
      [since],
    );
    return n(row?.c);
  }

  // ── System health (reuses QueueService + a DB ping) ─────────────────────
  private async systemHealth() {
    let db: { status: Health; latencyMs: number | null } = { status: 'unknown', latencyMs: null };
    const t0 = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      db = { status: 'up', latencyMs: Date.now() - t0 };
    } catch (err) {
      this.logger.error(`DB ping failed: ${(err as Error)?.message}`);
      db = { status: 'down', latencyMs: null };
    }

    let redis: { status: Health; latencyMs: number | null } = { status: 'unknown', latencyMs: null };
    try {
      redis = { status: 'up', latencyMs: await this.queues.redisPing() };
    } catch {
      redis = { status: 'down', latencyMs: null };
    }

    // Worker liveness via the shared reaper heartbeat (age in seconds).
    let workers: { status: Health; heartbeatAgeSeconds: number | null } = {
      status: 'unknown',
      heartbeatAgeSeconds: null,
    };
    try {
      const hb = await this.queues.kvGet(WORKER_HEARTBEAT_KEY);
      if (hb) {
        const parsed = JSON.parse(hb) as { at: string };
        const age = Math.round((Date.now() - new Date(parsed.at).getTime()) / 1000);
        workers = { status: age < 3600 ? 'up' : 'degraded', heartbeatAgeSeconds: age };
      }
    } catch {
      /* heartbeat absent → unknown */
    }

    return {
      api: { status: 'up' as Health },
      database: db,
      redis,
      bullmq: { status: (redis.status === 'up' ? 'up' : 'down') as Health },
      workers,
    };
  }

  // ── Traffic (api_logs) ──────────────────────────────────────────────────
  private async traffic() {
    const [row] = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS last_hour,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
        COALESCE(AVG(response_time_ms) FILTER (WHERE created_at >= now() - interval '1 hour'), 0) AS avg_ms,
        COALESCE(
          100.0 * COUNT(*) FILTER (WHERE status_code >= 500 AND created_at >= now() - interval '1 hour')
          / NULLIF(COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour'), 0), 0
        ) AS error_rate
      FROM api_logs
    `);
    const slow = await this.dataSource.query(`
      SELECT endpoint, method, ROUND(AVG(response_time_ms))::int AS avg_ms, COUNT(*)::int AS count
      FROM api_logs
      WHERE created_at >= now() - interval '24 hours' AND response_time_ms IS NOT NULL AND endpoint IS NOT NULL
      GROUP BY endpoint, method
      ORDER BY avg_ms DESC
      LIMIT 8
    `);
    return {
      requestsLastHour: n(row.last_hour),
      requestsToday: n(row.today),
      avgResponseTimeMs: Math.round(n(row.avg_ms)),
      errorRatePct: Math.round(n(row.error_rate) * 100) / 100,
      slowEndpoints: slow.map((s: Record<string, unknown>) => ({
        endpoint: s.endpoint as string,
        method: (s.method as string) ?? null,
        avgMs: n(s.avg_ms),
        count: n(s.count),
      })),
    };
  }

  // ── Webhooks (webhook_logs) ─────────────────────────────────────────────
  private async webhooks() {
    const byStatus = await this.dataSource.query(
      `SELECT COALESCE(status, 'unknown') AS status, COUNT(*)::int AS count FROM webhook_logs GROUP BY status`,
    );
    const isFail = (s: string) => /fail|error/i.test(s);
    const isOk = (s: string) => /success|ok|process|deliver/i.test(s);
    let success = 0;
    let failed = 0;
    for (const r of byStatus) {
      if (isFail(r.status)) failed += n(r.count);
      else if (isOk(r.status)) success += n(r.count);
    }
    const [last] = await this.dataSource.query(`
      SELECT
        MAX(created_at) FILTER (WHERE status ~* 'success|ok|process|deliver') AS last_success,
        MAX(created_at) FILTER (WHERE status ~* 'fail|error') AS last_failure,
        COUNT(*)::int AS total
      FROM webhook_logs
    `);
    return {
      total: n(last.total),
      success,
      failed,
      lastSuccessAt: last.last_success ? new Date(last.last_success).toISOString() : null,
      lastFailureAt: last.last_failure ? new Date(last.last_failure).toISOString() : null,
      byStatus: byStatus.map((r: Record<string, unknown>) => ({
        status: r.status as string,
        count: n(r.count),
      })),
    };
  }

  // ── Infrastructure (process + OS + storage proxy) ───────────────────────
  private async infrastructure() {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    let storage: {
      r2Configured: boolean;
      verificationDocs: number;
      verificationBytes: number;
    } = { r2Configured: this.storage.isConfigured(), verificationDocs: 0, verificationBytes: 0 };
    try {
      const [s] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS docs, COALESCE(SUM(size_bytes),0)::bigint AS bytes
           FROM tenant_verification_documents WHERE storage_key IS NOT NULL`,
      );
      storage = { ...storage, verificationDocs: n(s.docs), verificationBytes: n(s.bytes) };
    } catch {
      /* ignore */
    }

    return {
      memory: {
        rssMb: mb(mem.rss),
        heapUsedMb: mb(mem.heapUsed),
        heapTotalMb: mb(mem.heapTotal),
        systemTotalMb: mb(totalMem),
        systemUsedPct: Math.round((1 - freeMem / totalMem) * 1000) / 10,
      },
      cpu: { loadAvg1: Math.round(os.loadavg()[0] * 100) / 100, cores: os.cpus().length },
      uptimeSeconds: Math.round(process.uptime()),
      // Disk usage is intentionally omitted (no cross-platform primitive without
      // extra deps). Object storage is reported via the R2 verification-doc proxy.
      storage,
    };
  }

  // ── External services (config presence, not live probes) ────────────────
  private externalServices(): { name: string; status: ServiceStatus; detail: string }[] {
    const has = (k: string) => !!this.config.get<string>(k);
    return [
      {
        name: 'WhatsApp (Meta Tech Provider)',
        // Checks the platform META APP, which is all that is configurable here:
        // clinics connect their own WABA/number/token via Embedded Signup, and
        // those live on whatsapp_accounts, not in env. (This previously probed
        // WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID — the shared-number
        // vars removed with the PLATFORM_ENV fallback — so it always reported
        // "not_configured" regardless of the real state.)
        status:
          has('META_APP_ID') && (has('META_APP_SECRET') || has('WHATSAPP_APP_SECRET'))
            ? 'configured'
            : 'not_configured',
        detail: 'Platform Meta App (tenants connect their own WABA via Embedded Signup)',
      },
      { name: 'AI (OpenAI)', status: has('OPENAI_API_KEY') ? 'configured' : 'not_configured', detail: 'Chat + embeddings' },
      { name: 'Payment Gateway (Tap)', status: has('TAP_LIVE_SECRET_KEY') || has('TAP_TEST_SECRET_KEY') ? 'configured' : 'not_configured', detail: 'Card charges + webhooks' },
      { name: 'Object Storage (R2)', status: this.storage.isConfigured() ? 'configured' : 'not_configured', detail: 'Verification documents' },
      { name: 'Email Provider (Resend)', status: has('RESEND_API_KEY') ? 'configured' : 'not_configured', detail: 'Transactional email via EmailService' },
    ];
  }

  // ── WhatsApp / Meta readiness (dev + admin diagnostics) ─────────────────
  /**
   * Per-value configured/missing breakdown for the platform Meta App, plus
   * Redis and worker health (reused from `systemHealth`). Deliberately does
   * NOT read via `MetaConfig` — that class is scoped to the WhatsApp module
   * and pulling it in here would wire a cross-module dependency for what is
   * just a handful of `ConfigService.get` presence checks; the trimming logic
   * is mirrored, not duplicated in spirit; MetaConfig stays the sole place
   * that decides public vs. secret and how those values are actually used.
   *
   * `webhookCallbackUrl` is derived from the request that called this
   * endpoint (protocol + host), not a new env var — this API and the webhook
   * endpoint are served by the same app, so the admin's own request tells us
   * exactly what a publicly reachable base URL looks like for them.
   */
  async whatsappReadiness(requestOrigin?: string) {
    const has = (k: string): boolean => !!this.config.get<string>(k)?.trim();

    const values = {
      appId: has('META_APP_ID'),
      embeddedSignupConfigId: has('META_EMBEDDED_SIGNUP_CONFIG_ID'),
      appSecret: has('META_APP_SECRET') || has('WHATSAPP_APP_SECRET'),
      webhookVerifyToken: has('META_WEBHOOK_VERIFY_TOKEN') || has('WHATSAPP_VERIFY_TOKEN'),
      graphApiVersion: has('META_GRAPH_API_VERSION'), // false = using the v21.0 default, not "broken"
    };

    let redis: Health = 'unknown';
    try {
      await this.queues.redisPing();
      redis = 'up';
    } catch {
      redis = 'down';
    }

    let workers: Health = 'unknown';
    try {
      const hb = await this.queues.kvGet(WORKER_HEARTBEAT_KEY);
      if (hb) {
        const parsed = JSON.parse(hb) as { at: string };
        const age = Math.round((Date.now() - new Date(parsed.at).getTime()) / 1000);
        workers = age < 3600 ? 'up' : 'degraded';
      }
    } catch {
      /* heartbeat absent → unknown */
    }

    return {
      values: {
        appId: values.appId ? 'configured' : 'missing',
        embeddedSignupConfigId: values.embeddedSignupConfigId ? 'configured' : 'missing',
        appSecret: values.appSecret ? 'configured' : 'missing',
        webhookVerifyToken: values.webhookVerifyToken ? 'configured' : 'missing',
        graphApiVersion: values.graphApiVersion ? 'configured' : 'missing',
      },
      embeddedSignupReady: values.appId && values.embeddedSignupConfigId && values.appSecret,
      webhookReady: values.appSecret && values.webhookVerifyToken,
      webhookCallbackUrl: requestOrigin ? `${requestOrigin}/api/v1/whatsapp/webhooks/events` : null,
      redis,
      workers,
    };
  }

  // ── Alerts (derived) ────────────────────────────────────────────────────
  private alerts(input: {
    system: Awaited<ReturnType<MonitoringService['systemHealth']>>;
    failedJobs: number;
    traffic: Awaited<ReturnType<MonitoringService['traffic']>>;
    webhooks: Awaited<ReturnType<MonitoringService['webhooks']>>;
  }): { level: AlertLevel; message: string }[] {
    const out: { level: AlertLevel; message: string }[] = [];
    if (input.system.database.status === 'down') out.push({ level: 'critical', message: 'Database is unreachable' });
    if (input.system.redis.status === 'down') out.push({ level: 'critical', message: 'Redis is unreachable' });
    if (input.system.workers.status === 'degraded') {
      out.push({ level: 'warning', message: `Worker heartbeat is stale (${input.system.workers.heartbeatAgeSeconds}s)` });
    }
    if (input.system.workers.status === 'unknown') {
      out.push({ level: 'warning', message: 'No worker heartbeat detected' });
    }
    if (input.failedJobs > 0) out.push({ level: 'warning', message: `${input.failedJobs} failed background job(s)` });
    if (input.traffic.errorRatePct > 5) {
      out.push({ level: 'warning', message: `5xx error rate is ${input.traffic.errorRatePct}% in the last hour` });
    }
    if (input.webhooks.failed > 0) out.push({ level: 'warning', message: `${input.webhooks.failed} failed webhook(s)` });
    if (out.length === 0) out.push({ level: 'healthy', message: 'All systems operational' });
    return out;
  }
}

import { MetricsService } from './metrics.service';

describe('MetricsService (M14)', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('exposes the standard Prometheus content type', () => {
    expect(service.contentType).toMatch(/^text\/plain/);
  });

  it('renders bullmq_jobs_total after recording a job event, labeled by queue and status', async () => {
    service.recordJobEvent('notifications', 'completed');
    service.recordJobEvent('notifications', 'failed');
    const body = await service.render();
    expect(body).toContain('bullmq_jobs_total');
    expect(body).toContain('queue="notifications"');
    expect(body).toContain('status="completed"');
    expect(body).toContain('status="failed"');
  });

  it('renders bullmq_queue_depth as a gauge reflecting the last setQueueDepth call', async () => {
    service.setQueueDepth('campaigns.processRecipient', 'waiting', 42);
    const body = await service.render();
    expect(body).toContain('bullmq_queue_depth');
    expect(body).toContain('queue="campaigns.processRecipient"');
    expect(body).toContain('42');
  });

  it('renders the three db_pool_* gauges from a single setDbPoolStats call (P1.3)', async () => {
    service.setDbPoolStats({ total: 15, idle: 10, waiting: 2 });
    const body = await service.render();
    expect(body).toContain('db_pool_total 15');
    expect(body).toContain('db_pool_idle 10');
    expect(body).toContain('db_pool_waiting 2');
  });

  it('db_pool_waiting reflects the LATEST sample, not an accumulated total (it is a gauge, not a counter)', async () => {
    service.setDbPoolStats({ total: 15, idle: 5, waiting: 8 });
    service.setDbPoolStats({ total: 15, idle: 15, waiting: 0 });
    const body = await service.render();
    expect(body).toContain('db_pool_waiting 0');
    expect(body).not.toContain('db_pool_waiting 8');
  });

  it('renders cache_operations_total labeled by cache name and hit/miss result', async () => {
    service.recordCacheOperation('analytics', 'hit');
    service.recordCacheOperation('embedding', 'miss');
    const body = await service.render();
    expect(body).toContain('cache="analytics"');
    expect(body).toContain('result="hit"');
    expect(body).toContain('cache="embedding"');
    expect(body).toContain('result="miss"');
  });

  it('renders worker_heartbeat_timestamp_seconds after setWorkerHeartbeat', async () => {
    service.setWorkerHeartbeat('payments.reconcile', 1_700_000_000);
    const body = await service.render();
    expect(body).toContain('worker_heartbeat_timestamp_seconds');
    expect(body).toContain('worker="payments.reconcile"');
    expect(body).toContain('1700000000');
  });

  it('defaults the heartbeat timestamp to "now" when none is given', async () => {
    const before = Date.now() / 1000;
    service.setWorkerHeartbeat('some.sweep');
    const body = await service.render();
    const match = body.match(
      /worker_heartbeat_timestamp_seconds\{worker="some\.sweep"\} (\S+)/,
    );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(before);
  });

  it('renders auth_login_protection_events_total after recordLoginProtectionEvent, labeled by event', async () => {
    service.recordLoginProtectionEvent('engaged');
    service.recordLoginProtectionEvent('store_unavailable');
    const body = await service.render();
    expect(body).toContain('auth_login_protection_events_total');
    expect(body).toContain('event="engaged"');
    expect(body).toContain('event="store_unavailable"');
  });

  it('renders throttler_storage_events_total after recordThrottlerStorageEvent, labeled by event', async () => {
    service.recordThrottlerStorageEvent('redis_unavailable');
    const body = await service.render();
    expect(body).toContain('throttler_storage_events_total');
    expect(body).toContain('event="redis_unavailable"');
  });

  it('renders http_request_duration_seconds after recordHttpRequest, labeled by method and status_code — PERF-BE-002', async () => {
    // The whole point of this metric: a guard-rejected request (429/401/403/
    // 503) must be observable here even though it never reaches
    // ApiLoggingInterceptor or produces an api_logs row (T025's confirmed gap).
    service.recordHttpRequest('GET', 429, 0.003);
    service.recordHttpRequest('POST', 200, 0.05);
    const body = await service.render();
    expect(body).toContain('http_request_duration_seconds');
    expect(body).toContain('method="GET",status_code="429"');
    expect(body).toContain('method="POST",status_code="200"');
  });

  // ── 009-auth-abuse-resistance (ZT-002, ZT-006, ZT-010) ──────────────────

  it('renders auth_abuse_limiter_events_total after recordAuthAbuseLimiterEvent, labeled by limiter and event', async () => {
    service.recordAuthAbuseLimiterEvent('forgot', 'refused');
    service.recordAuthAbuseLimiterEvent('login', 'degraded_refused');
    const body = await service.render();
    expect(body).toContain('auth_abuse_limiter_events_total');
    expect(body).toContain('limiter="forgot"');
    expect(body).toContain('event="refused"');
    expect(body).toContain('limiter="login"');
    expect(body).toContain('event="degraded_refused"');
  });

  it('renders auth_recovery_events_total after recordAuthRecoveryEvent, labeled by event', async () => {
    service.recordAuthRecoveryEvent('multiplicity_violation');
    const body = await service.render();
    expect(body).toContain('auth_recovery_events_total');
    expect(body).toContain('event="multiplicity_violation"');
  });

  it('recordThrottlerStorageEvent accepts the extended degraded_entered/recovered events alongside redis_unavailable', async () => {
    service.recordThrottlerStorageEvent('degraded_entered');
    service.recordThrottlerStorageEvent('recovered');
    const body = await service.render();
    expect(body).toContain('event="degraded_entered"');
    expect(body).toContain('event="recovered"');
  });

  it('auth_abuse_limiter_events_total label set is a bounded, closed enum — no attacker-controlled string can reach a label (research.md §R9)', async () => {
    // Exercise every documented (limiter × event) combination and confirm
    // the resulting series count matches exactly — no more, no fewer, and
    // nothing beyond the closed enums appears.
    const limiters: Array<Parameters<MetricsService['recordAuthAbuseLimiterEvent']>[0]> = [
      'login',
      'forgot',
      'reset_account',
      'reset_invalid',
      'register_identity',
      'register_client',
      'register_endpoint',
    ];
    const events: Array<Parameters<MetricsService['recordAuthAbuseLimiterEvent']>[1]> = [
      'allowed',
      'refused',
      'suppressed',
      'degraded_allowed',
      'degraded_refused',
    ];
    for (const limiter of limiters) {
      for (const event of events) {
        service.recordAuthAbuseLimiterEvent(limiter, event);
      }
    }
    const body = await service.render();
    const seriesLines = body
      .split('\n')
      .filter((l) => l.startsWith('auth_abuse_limiter_events_total{'));
    expect(seriesLines).toHaveLength(limiters.length * events.length);
  });

  it('two instances use independent registries — no cross-instance metric leakage', async () => {
    const other = new MetricsService();
    service.recordJobEvent('q1', 'completed');
    const otherBody = await other.render();
    expect(otherBody).not.toContain('queue="q1"');
  });

  it('includes default Node process metrics (event loop, heap, CPU)', async () => {
    const body = await service.render();
    expect(body).toMatch(/process_cpu_user_seconds_total|nodejs_heap_size/);
  });

  // ── 015-db-api-efficiency-audit — P10/T062/T063 (spec §21.2 gap) ──────────

  it('renders db_queries_total after recordDbQuery, labeled by route only', async () => {
    service.recordDbQuery('/appointments/:id');
    service.recordDbQuery('/appointments/:id');
    service.recordDbQuery('/crm/customers');
    const body = await service.render();
    expect(body).toContain('db_queries_total');
    expect(body).toContain('route="/appointments/:id"} 2');
    expect(body).toContain('route="/crm/customers"} 1');
  });

  it('db_queries_total never carries a tenant id or query text — the only label is route', async () => {
    service.recordDbQuery('/crm/customers');
    const body = await service.render();
    const line = body
      .split('\n')
      .find((l) => l.startsWith('db_queries_total{'))!;
    // Exactly one label (`route`) on the series — no second label slot for a
    // tenant id, statement hash, or anything else to have been added to.
    expect(line.match(/="/g)).toHaveLength(1);
  });

  describe('WhatsApp AI observability series (Step 12)', () => {
    it('renders each series with closed labels only — no tenant, contact or phone', async () => {
      service.recordWhatsappInboundEvent('accepted');
      service.recordWhatsappInboundEvent('deduplicated');
      service.recordWhatsappInboundEvent('no_tenant');
      service.recordWhatsappAiReply('sent');
      service.recordWhatsappAiReply('suppressed');
      service.recordWhatsappAiReply('deduped');
      service.recordWhatsappAiReply('failed');
      service.observeWhatsappAiTurnSeconds(3.2);
      service.recordAiScopeBlock('whatsapp', 'offtopic');
      service.recordAiScopeBlock('public', 'reply-code');
      service.recordWhatsappContactLockBusy();

      const body = await service.render();

      for (const result of ['accepted', 'deduplicated', 'no_tenant']) {
        expect(body).toContain(
          `whatsapp_inbound_events_total{result="${result}"} 1`,
        );
      }
      for (const result of ['sent', 'suppressed', 'deduped', 'failed']) {
        expect(body).toContain(`whatsapp_ai_reply_total{result="${result}"} 1`);
      }
      expect(body).toContain('whatsapp_ai_turn_seconds_count 1');
      expect(body).toContain(
        'ai_scope_blocks_total{channel="whatsapp",category="offtopic"} 1',
      );
      expect(body).toContain(
        'ai_scope_blocks_total{channel="public",category="reply-code"} 1',
      );
      expect(body).toContain('whatsapp_contact_lock_busy_total 1');
    });

    it('buckets a turn duration (3.2s lands in le=5, not le=2)', async () => {
      service.observeWhatsappAiTurnSeconds(3.2);
      const body = await service.render();
      expect(body).toContain('whatsapp_ai_turn_seconds_bucket{le="2"} 0');
      expect(body).toContain('whatsapp_ai_turn_seconds_bucket{le="5"} 1');
    });
  });
});

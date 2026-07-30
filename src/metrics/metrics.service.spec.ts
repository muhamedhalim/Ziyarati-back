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
});

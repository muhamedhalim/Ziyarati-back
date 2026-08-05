import {
  ALL_QUEUES,
  QUEUE,
  DISPATCH_ONLY_QUEUES,
  resolveWorkerRole,
  queuesForRole,
  bullPrefix,
  cacheKeyPrefix,
  dlqExpiresAt,
  PII_REMOVE_ON_FAIL_SECONDS,
  STANDARD_REMOVE_ON_FAIL_SECONDS,
} from './queue.constants';

// FND-037 — a DLQ-parked job is never processed by any Worker (see
// DLQ_QUEUES's own doc comment), so BullMQ's `removeOnComplete`/`removeOnFail`
// job options never fire for it — those only trigger on the corresponding
// state transition. Today PII-adjacent DLQ payloads (WHATSAPP_DLQ) sit under
// no enforced expiry at all — effectively the LONG class forever, not the
// SHORT PII class `PII_REMOVE_ON_FAIL_SECONDS` already defines and already
// applies correctly to the pre-DLQ `removeOnFail` window. `dlqExpiresAt`
// stamps an explicit deadline at enqueue time so an external sweep
// (QueueMonitorService) can actually remove it once elapsed.
describe('dlqExpiresAt (FND-037 — DLQ retention class)', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('stamps the SHORT PII-adjacent class (6h) for a PII-bearing DLQ (e.g. WHATSAPP_DLQ)', () => {
    const expected = new Date(now.getTime() + PII_REMOVE_ON_FAIL_SECONDS * 1000).toISOString();
    expect(dlqExpiresAt(true, now)).toBe(expected);
    expect(PII_REMOVE_ON_FAIL_SECONDS).toBe(6 * 3600); // sanity: matches the existing pre-DLQ constant exactly, no drift
  });

  it('stamps the STANDARD class (7d) for a non-PII-bearing DLQ (e.g. CAMPAIGNS_DLQ, NOTIFICATIONS_DLQ, WEBHOOKS_DLQ)', () => {
    const expected = new Date(now.getTime() + STANDARD_REMOVE_ON_FAIL_SECONDS * 1000).toISOString();
    expect(dlqExpiresAt(false, now)).toBe(expected);
    expect(STANDARD_REMOVE_ON_FAIL_SECONDS).toBe(7 * 24 * 3600); // matches defaultJobOptions' removeOnFail.age exactly
  });

  it('the two classes are genuinely different (the whole point of the finding)', () => {
    expect(dlqExpiresAt(true, now)).not.toBe(dlqExpiresAt(false, now));
    expect(PII_REMOVE_ON_FAIL_SECONDS).toBeLessThan(STANDARD_REMOVE_ON_FAIL_SECONDS);
  });
});

describe('bullPrefix / cacheKeyPrefix (M3 — environment prefix, opt-in)', () => {
  const ORIGINAL = process.env.QUEUE_ENV_PREFIX;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.QUEUE_ENV_PREFIX;
    else process.env.QUEUE_ENV_PREFIX = ORIGINAL;
  });

  it('defaults to undefined/empty when QUEUE_ENV_PREFIX is unset — zero behavior change for every existing deployment', () => {
    delete process.env.QUEUE_ENV_PREFIX;
    expect(bullPrefix()).toBeUndefined();
    expect(cacheKeyPrefix()).toBe('');
  });

  it('is also a no-op for an empty/whitespace-only value', () => {
    process.env.QUEUE_ENV_PREFIX = '   ';
    expect(bullPrefix()).toBeUndefined();
    expect(cacheKeyPrefix()).toBe('');
  });

  it('returns the trimmed prefix when set, and a colon-suffixed form for cache keys', () => {
    process.env.QUEUE_ENV_PREFIX = ' staging ';
    expect(bullPrefix()).toBe('staging');
    expect(cacheKeyPrefix()).toBe('staging:');
  });
});

describe('resolveWorkerRole (Phase 0 worker split)', () => {
  const ORIGINAL = process.env.WORKER_ROLE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WORKER_ROLE;
    else process.env.WORKER_ROLE = ORIGINAL;
  });

  it('defaults to "all" when WORKER_ROLE is unset — zero behavior change for every existing deployment', () => {
    delete process.env.WORKER_ROLE;
    expect(resolveWorkerRole()).toBe('all');
  });

  it.each(['critical', 'dispatch', 'CRITICAL', ' dispatch '])(
    'accepts "%s"',
    (raw) => {
      process.env.WORKER_ROLE = raw;
      expect(['critical', 'dispatch']).toContain(resolveWorkerRole());
    },
  );

  it('falls back to "all" for an unrecognized value rather than crashing the worker boot', () => {
    process.env.WORKER_ROLE = 'bogus';
    expect(resolveWorkerRole()).toBe('all');
  });
});

describe('queuesForRole (Phase 0 worker split)', () => {
  it('"all" registers every queue — identical to pre-Phase-0 behavior', () => {
    expect(queuesForRole('all')).toEqual(ALL_QUEUES);
  });

  it('"dispatch" registers ONLY the campaign recipient-dispatch queue', () => {
    expect(queuesForRole('dispatch')).toEqual([QUEUE.CAMPAIGNS_PROCESS]);
  });

  it('"critical" registers every queue EXCEPT the dispatch one, and the two sets never overlap', () => {
    const critical = queuesForRole('critical');
    const dispatch = queuesForRole('dispatch');

    expect(critical).not.toContain(QUEUE.CAMPAIGNS_PROCESS);
    expect(critical.length + dispatch.length).toBe(ALL_QUEUES.length);
    for (const q of dispatch) expect(critical).not.toContain(q);
  });

  it('DISPATCH_ONLY_QUEUES is exactly one queue (the hot path the audit measured)', () => {
    expect(DISPATCH_ONLY_QUEUES).toEqual([QUEUE.CAMPAIGNS_PROCESS]);
  });
});

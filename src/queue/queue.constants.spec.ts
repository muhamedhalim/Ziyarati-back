import { ALL_QUEUES, QUEUE, DISPATCH_ONLY_QUEUES, resolveWorkerRole, queuesForRole } from './queue.constants';

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

  it.each(['critical', 'dispatch', 'CRITICAL', ' dispatch '])('accepts "%s"', (raw) => {
    process.env.WORKER_ROLE = raw;
    expect(['critical', 'dispatch']).toContain(resolveWorkerRole());
  });

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

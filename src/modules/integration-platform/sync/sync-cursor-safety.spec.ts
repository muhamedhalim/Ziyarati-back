import { IntegrationSyncService } from './integration-sync.service';
import {
  JOB_STATUS,
  SYNC_DIRECTION,
  SYNC_STOP_REASON,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';

/**
 * NO RECORD LOSS during page-level and item-level failure.
 *
 * The property under test is the one that actually matters for a sync engine:
 * `last_successful_cursor` must never move past a record that was not safely
 * handled, because that watermark is where a retry resumes from. If it advanced
 * over a failure, that record would be silently skipped forever.
 */

/** A job row that behaves like the entity for the fields the service touches. */
type JobRow = Record<string, any>;
function makeJob(over: Record<string, unknown> = {}): JobRow {
  return {
    id: 'sync-1',
    tenant: { id: 't1' },
    connection: { id: 'c1' },
    resource_type: 'customer',
    direction: SYNC_DIRECTION.INBOUND,
    mode: 'incremental',
    status: JOB_STATUS.PENDING,
    cursor: null,
    attempted_cursor: null,
    last_successful_cursor: null,
    next_cursor: null,
    cursor_kind: 'opaque',
    pages_fetched: 0,
    stop_reason: null,
    processed: 0,
    created_count: 0,
    updated_count: 0,
    skipped_count: 0,
    conflicted_count: 0,
    failed_count: 0,
    retry_count: 0,
    cancel_requested: false,
    started_at: null,
    finished_at: null,
    triggered_by: null,
    ...over,
  };
}

interface Page {
  records: Array<{ externalId: string; data: Record<string, unknown> }>;
  nextCursor: string | null;
  hasMore: boolean;
}

/** Wires the service with in-memory doubles and returns the mutated job row. */
function buildService(pages: Page[], outcomes: Record<string, string> = {}) {
  const job = makeJob();
  const jobs = {
    findOne: jest.fn(async (opts: { select?: Record<string, unknown> }) =>
      opts?.select ? { cancel_requested: job.cancel_requested } : job,
    ),
    save: jest.fn(async (x: unknown) => x),
    update: jest.fn(async () => ({ affected: 1 })),
    find: jest.fn(async () => []),
    findAndCount: jest.fn(async () => [[], 0]),
    create: jest.fn((x: unknown) => x),
  } as never;

  let pageIndex = 0;
  const providers = {
    pullChanges: jest.fn(async () => pages[Math.min(pageIndex++, pages.length - 1)]),
  } as never;

  const upsert = {
    upsertOne: jest.fn(async (
      _t: string, _r: string, _c: string, _p: string, externalId: string,
    ) => ({
      outcome: outcomes[externalId] ?? UPSERT_OUTCOME.UPDATED,
      externalId,
      internalId: `int-${externalId}`,
    })),
  } as never;

  const connections = {
    requireActive: jest.fn(async () => ({ id: 'c1', sync_direction: SYNC_DIRECTION.BIDIRECTIONAL })),
    conflictPolicyOf: jest.fn(() => 'external_wins'),
    markSuccess: jest.fn(async () => undefined),
    markError: jest.fn(async () => undefined),
  } as never;

  const svc = new IntegrationSyncService(
    jobs,
    connections,
    upsert,
    providers,
    { record: jest.fn() } as never,
    { enqueueIntegrationSync: jest.fn() } as never,
    { admit: jest.fn(), assertSyncConcurrency: jest.fn() } as never,
    { resolve: jest.fn(async () => 'svc-user'), resolveActorUserId: jest.fn(async () => 'svc-user') } as never,
    { findByInternalId: jest.fn(), link: jest.fn() } as never,
    {} as never, // DataSource — unused by `process()`, only `start()` needs it
  );
  return { svc, job, providers, upsert };
}

describe('sync cursor safety — no record loss', () => {
  it('advances the successful cursor only after a FULLY handled page', async () => {
    const { svc, job } = buildService([
      { records: [{ externalId: 'A', data: {} }], nextCursor: 'cur-1', hasMore: true },
      { records: [{ externalId: 'B', data: {} }], nextCursor: 'cur-2', hasMore: false },
    ]);
    await svc.process('sync-1');
    expect(job.last_successful_cursor).toBe('cur-2');
    expect(job.stop_reason).toBe(SYNC_STOP_REASON.COMPLETED);
    expect(job.status).toBe(JOB_STATUS.COMPLETED);
  });

  it('does NOT advance past a page containing a failed record', async () => {
    const { svc, job } = buildService(
      [
        { records: [{ externalId: 'A', data: {} }], nextCursor: 'cur-1', hasMore: true },
        { records: [{ externalId: 'B', data: {} }, { externalId: 'C', data: {} }], nextCursor: 'cur-2', hasMore: true },
      ],
      { B: UPSERT_OUTCOME.FAILED },
    );
    await svc.process('sync-1');

    // Page 1 was clean → watermark is cur-1. Page 2 had a failure → the run
    // stops there and the watermark stays put, so a retry re-fetches page 2.
    expect(job.last_successful_cursor).toBe('cur-1');
    expect(job.attempted_cursor).toBe('cur-1'); // the boundary page 2 was requested from
    expect(job.stop_reason).toBe(SYNC_STOP_REASON.ITEM_FAILURE);
    expect(job.status).toBe(JOB_STATUS.PARTIALLY_COMPLETED);
  });

  it('still processes the REST of a page after one item fails (no partial abort)', async () => {
    const { svc, job, upsert } = buildService(
      [{ records: [{ externalId: 'A', data: {} }, { externalId: 'B', data: {} }, { externalId: 'C', data: {} }], nextCursor: 'cur-1', hasMore: false }],
      { A: UPSERT_OUTCOME.FAILED },
    );
    await svc.process('sync-1');
    expect((upsert as unknown as { upsertOne: jest.Mock }).upsertOne).toHaveBeenCalledTimes(3);
    expect(job.processed).toBe(3);
    expect(job.failed_count).toBe(1);
    expect(job.last_successful_cursor).toBeNull(); // never advanced past the failure
  });

  it('a CONFLICT does not block the watermark — it is durably recorded for review', async () => {
    const { svc, job } = buildService(
      [{ records: [{ externalId: 'A', data: {} }], nextCursor: 'cur-1', hasMore: false }],
      { A: UPSERT_OUTCOME.CONFLICTED },
    );
    await svc.process('sync-1');
    expect(job.conflicted_count).toBe(1);
    expect(job.last_successful_cursor).toBe('cur-1');
  });

  it('breaks a pagination LOOP when the provider repeats a cursor', async () => {
    // Same cursor forever, always claiming more — the classic runaway provider.
    const { svc, job, providers } = buildService([
      { records: [{ externalId: 'A', data: {} }], nextCursor: null, hasMore: true },
    ]);
    await svc.process('sync-1');
    expect(job.stop_reason).toBe(SYNC_STOP_REASON.REPEATED_CURSOR);
    // Stopped after the second request rather than spinning indefinitely.
    expect((providers as unknown as { pullChanges: jest.Mock }).pullChanges.mock.calls.length).toBeLessThan(5);
  });

  it('deduplicates a record repeated within one page', async () => {
    const { svc, job, upsert } = buildService([
      { records: [{ externalId: 'A', data: {} }, { externalId: 'A', data: {} }], nextCursor: 'cur-1', hasMore: false },
    ]);
    await svc.process('sync-1');
    expect((upsert as unknown as { upsertOne: jest.Mock }).upsertOne).toHaveBeenCalledTimes(1);
    expect(job.skipped_count).toBe(1);
    expect(job.processed).toBe(2);
  });

  it('records how many pages were fetched and what the provider says is next', async () => {
    const { svc, job } = buildService([
      { records: [], nextCursor: 'cur-1', hasMore: true },
      { records: [], nextCursor: 'cur-2', hasMore: false },
    ]);
    await svc.process('sync-1');
    expect(job.pages_fetched).toBe(2);
    expect(job.next_cursor).toBe('cur-2');
    expect(job.cursor_kind).toBe('opaque');
  });

  it('honours a cancellation request without advancing the watermark', async () => {
    const { svc, job } = buildService([
      { records: [{ externalId: 'A', data: {} }], nextCursor: 'cur-1', hasMore: true },
    ]);
    job.cancel_requested = true;
    await svc.process('sync-1');
    expect(job.status).toBe(JOB_STATUS.CANCELLED);
    expect(job.last_successful_cursor).toBeNull();
  });

  it('resumes from the last SUCCESSFUL cursor, not the attempted one', async () => {
    const { svc, job, providers } = buildService([
      { records: [], nextCursor: 'cur-9', hasMore: false },
    ]);
    // A prior run got as far as attempting cur-5 but only committed cur-3.
    job.cursor = 'cur-5';
    job.attempted_cursor = 'cur-5';
    job.last_successful_cursor = 'cur-3';
    await svc.process('sync-1');
    const firstCall = (providers as unknown as { pullChanges: jest.Mock }).pullChanges.mock.calls[0];
    expect(firstCall[2]).toBe('cur-3');
  });
});

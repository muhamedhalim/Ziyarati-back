import { DataSource } from 'typeorm';

import { OutboxRelayService, outboxBackoffMs } from './outbox-relay.service';
import { QueueService } from '../queue/queue.service';
import { OutboxStatus } from '../entities/enums';
import {
  createMockDataSource,
  createMockQueryBuilder,
  MockDataSource,
  MockQueryBuilder,
} from '../../test/utils/mock-factories';

describe('OutboxRelayService', () => {
  let service: OutboxRelayService;
  let dataSource: MockDataSource;
  let queue: { publish: jest.Mock; hasEnqueueHeadroom: jest.Mock };
  /** The claim-phase query builder (SELECT ... FOR UPDATE SKIP LOCKED, then the PUBLISHING UPDATE) — built via `mgr.createQueryBuilder()` inside the short claim transaction. */
  let claimQb: MockQueryBuilder;
  /** The mark-phase query builder (PUBLISHED/PENDING/FAILED UPDATE) — built directly via `dataSource.createQueryBuilder()`, with NO transaction open. */
  let markQb: MockQueryBuilder;

  /** Invokes the private batch drainer directly (no interval/timer started). */
  const drain = () =>
    (service as unknown as { drainBatch: () => Promise<void> }).drainBatch();
  const recover = () =>
    (service as unknown as { runRecovery: () => Promise<void> }).runRecovery();

  beforeEach(() => {
    dataSource = createMockDataSource();
    queue = {
      publish: jest.fn().mockResolvedValue({ id: 'job-1' }),
      hasEnqueueHeadroom: jest.fn().mockResolvedValue(true),
    };
    claimQb = createMockQueryBuilder();
    markQb = createMockQueryBuilder();
    dataSource.manager.createQueryBuilder.mockReturnValue(claimQb);
    (dataSource.createQueryBuilder as jest.Mock).mockReturnValue(markQb);

    service = new OutboxRelayService(
      dataSource as unknown as DataSource,
      queue as unknown as QueueService,
    );
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'o1',
    queue: 'analytics',
    job_name: 'analytics.aggregate',
    payload: { tenantId: 't1', foo: 1 },
    opts: undefined,
    dedupe_key: 'dedupe-1',
    status: OutboxStatus.PENDING,
    publish_attempts: 0,
    published_at: null,
    last_error: null,
    ...overrides,
  });

  describe('claim phase (short transaction: PENDING -> PUBLISHING)', () => {
    it('claims a batch inside the transaction and flips it to PUBLISHING before any publish happens', async () => {
      const r = row();
      claimQb.getMany.mockResolvedValueOnce([r]);

      await drain();

      // The SELECT ran with a row lock + skip-locked (safe across replicas).
      expect(claimQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(claimQb.setOnLocked).toHaveBeenCalledWith('skip_locked');
      // The claim UPDATE set PUBLISHING — via the transactional manager, not the top-level dataSource.
      expect(claimQb.update).toHaveBeenCalledWith(expect.anything());
      expect(claimQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.PUBLISHING, claimed_at: expect.any(Date) }),
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1); // claim only — mark runs outside a transaction
    });

    it('does nothing when there are no pending rows (no claim UPDATE, no publish)', async () => {
      claimQb.getMany.mockResolvedValueOnce([]);
      await drain();
      expect(claimQb.update).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
    });
  });

  describe('publish + mark phases (outside any transaction)', () => {
    it('publishes a claimed row and marks it PUBLISHED, with no transaction held during the publish call', async () => {
      const r = row();
      claimQb.getMany.mockResolvedValueOnce([r]);

      await drain();

      expect(queue.publish).toHaveBeenCalledWith(
        'analytics',
        'analytics.aggregate',
        expect.objectContaining({ tenantId: 't1', foo: 1 }),
        'dedupe-1',
        undefined,
      );
      // The mark-phase UPDATE ran directly on dataSource — never inside a transaction.
      expect(markQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.PUBLISHED, published_at: expect.any(Date) }),
      );
      expect(markQb.execute).toHaveBeenCalled();
    });

    it('passes the row opts through to queue.publish (e.g. webhook delivery attempts/backoff)', async () => {
      const r = row({ opts: { attempts: 6, backoff: { type: 'exponential', delay: 5000 } } });
      claimQb.getMany.mockResolvedValueOnce([r]);
      await drain();
      expect(queue.publish).toHaveBeenCalledWith(
        'analytics', 'analytics.aggregate', expect.anything(), 'dedupe-1',
        { attempts: 6, backoff: { type: 'exponential', delay: 5000 } },
      );
    });

    it('reverts a row to PENDING (not FAILED) and records the error on a transient publish failure', async () => {
      const r = row();
      claimQb.getMany.mockResolvedValueOnce([r]);
      queue.publish.mockRejectedValueOnce(new Error('redis down'));

      await drain();

      expect(markQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.PENDING, publish_attempts: 1, last_error: 'redis down' }),
      );
    });

    it('CR-09: a failed row waits out an exponential backoff instead of being re-claimed on the next tick', async () => {
      const r = row({ publish_attempts: 2 }); // this failure is attempt 3 -> 4 s
      claimQb.getMany.mockResolvedValueOnce([r]);
      queue.publish.mockRejectedValueOnce(new Error('redis down'));
      const before = Date.now();

      await drain();

      const set = markQb.set.mock.calls.at(-1)![0] as { next_attempt_at: Date };
      expect(set.next_attempt_at).toBeInstanceOf(Date);
      expect(set.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + outboxBackoffMs(3) - 5);
      expect(set.next_attempt_at.getTime()).toBeLessThan(before + outboxBackoffMs(3) + 5_000);
    });

    it('CR-09: the claim query only takes rows whose backoff has elapsed', async () => {
      claimQb.getMany.mockResolvedValueOnce([]);
      await drain();
      expect(claimQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('next_attempt_at IS NULL OR o.next_attempt_at <= now()'),
      );
    });

    it('CR-09: a successful publish clears any earlier backoff', async () => {
      claimQb.getMany.mockResolvedValueOnce([row({ publish_attempts: 3 })]);
      await drain();
      expect(markQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.PUBLISHED, next_attempt_at: null }),
      );
    });

    it('parks a row as FAILED once max publish attempts are exhausted', async () => {
      const r = row({ publish_attempts: 19 }); // +1 → 10 === OUTBOX_MAX_ATTEMPTS default
      claimQb.getMany.mockResolvedValueOnce([r]);
      queue.publish.mockRejectedValueOnce(new Error('still down'));

      await drain();

      expect(markQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.FAILED, publish_attempts: 20, next_attempt_at: null }),
      );
    });

    it('CR-09: survives a Redis outage longer than the old 10-attempt / ~10 s budget', async () => {
      // Old behaviour: 10 failures in ~10 s -> FAILED. Now the 10th failure is still PENDING.
      claimQb.getMany.mockResolvedValueOnce([row({ publish_attempts: 9 })]);
      queue.publish.mockRejectedValueOnce(new Error('redis failover'));
      await drain();
      expect(markQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.PENDING, publish_attempts: 10 }),
      );
    });

    it('CR-09: backoff doubles from 1 s and is capped at 5 min', () => {
      expect([1, 2, 3, 4].map(outboxBackoffMs)).toEqual([1000, 2000, 4000, 8000]);
      expect(outboxBackoffMs(9)).toBe(256_000);
      expect(outboxBackoffMs(10)).toBe(300_000);
      expect(outboxBackoffMs(50)).toBe(300_000);
      expect(outboxBackoffMs(0)).toBe(1000);
    });
  });

  describe('stuck-PUBLISHING recovery sweep', () => {
    it('resets rows stuck in PUBLISHING past the threshold back to PENDING', async () => {
      (dataSource.createQueryBuilder as jest.Mock).mockReturnValueOnce(markQb);
      markQb.execute.mockResolvedValueOnce({ affected: 2, raw: [] });

      await recover();

      expect(markQb.update).toHaveBeenCalledWith(expect.anything());
      expect(markQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.PENDING }),
      );
      expect(markQb.where).toHaveBeenCalledWith(
        expect.stringContaining('claimed_at'),
        expect.objectContaining({ publishing: OutboxStatus.PUBLISHING }),
      );
    });

    it('also treats a NULL claimed_at as stale (gap-closure regression: NULL < cutoff is NULL in SQL, not true)', async () => {
      (dataSource.createQueryBuilder as jest.Mock).mockReturnValueOnce(markQb);
      markQb.execute.mockResolvedValueOnce({ affected: 1, raw: [] });

      await recover();

      expect(markQb.where).toHaveBeenCalledWith(
        expect.stringContaining('claimed_at IS NULL'),
        expect.anything(),
      );
    });

    it('CR-09: logs a stable OUTBOX_FAILED_ROWS token while parked rows remain', async () => {
      markQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] });
      (dataSource.query as jest.Mock).mockResolvedValueOnce([{ c: 3 }]);
      const errSpy = jest
        .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
        .mockImplementation(() => undefined);

      await recover();

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('OUTBOX_FAILED_ROWS count=3'));
    });

    it('CR-09: stays quiet when nothing is parked', async () => {
      markQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] });
      (dataSource.query as jest.Mock).mockResolvedValueOnce([{ c: 0 }]);
      const errSpy = jest
        .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
        .mockImplementation(() => undefined);

      await recover();

      expect(errSpy).not.toHaveBeenCalled();
    });

    it('does not overlap with itself (recovering guard)', async () => {
      (service as unknown as { recovering: boolean }).recovering = true;
      await recover();
      expect(markQb.execute).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('starts BOTH the poll timer and the recovery timer on bootstrap, and clears both on destroy', () => {
      jest.useFakeTimers();
      const setSpy = jest.spyOn(global, 'setInterval');
      const clearSpy = jest.spyOn(global, 'clearInterval');

      service.onApplicationBootstrap();
      expect(setSpy).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      expect(clearSpy).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('tick drains a batch and resets the running guard', async () => {
      claimQb.getMany.mockResolvedValueOnce([]);
      await (service as unknown as { tick: () => Promise<void> }).tick();
      expect((service as unknown as { running: boolean }).running).toBe(false);
    });

    it('tick swallows errors and still clears the running guard', async () => {
      claimQb.getMany.mockRejectedValueOnce(new Error('db down'));
      await (service as unknown as { tick: () => Promise<void> }).tick();
      expect((service as unknown as { running: boolean }).running).toBe(false);
    });

    // RL-08: rows wait in Postgres while Redis is near maxmemory.
    it('tick claims nothing while Redis has no enqueue headroom, then resumes', async () => {
      queue.hasEnqueueHeadroom.mockResolvedValueOnce(false);
      await (service as unknown as { tick: () => Promise<void> }).tick();
      expect(claimQb.getMany).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
      expect((service as unknown as { running: boolean }).running).toBe(false);

      claimQb.getMany.mockResolvedValueOnce([]);
      await (service as unknown as { tick: () => Promise<void> }).tick();
      expect(claimQb.getMany).toHaveBeenCalledTimes(1);
    });
  });
});

import { DataSource } from 'typeorm';

import { OutboxRelayService } from './outbox-relay.service';
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
  let queue: { publish: jest.Mock };
  /** The claim-phase query builder (SELECT ... FOR UPDATE SKIP LOCKED, then the PUBLISHING UPDATE) — built via `mgr.createQueryBuilder()` inside the short claim transaction. */
  let claimQb: MockQueryBuilder;
  /** The mark-phase query builder (PUBLISHED/PENDING/FAILED UPDATE) — built directly via `dataSource.createQueryBuilder()`, with NO transaction open. */
  let markQb: MockQueryBuilder;

  /** Invokes the private batch drainer directly (no interval/timer started). */
  const drain = () => (service as unknown as { drainBatch: () => Promise<void> }).drainBatch();
  const recover = () => (service as unknown as { runRecovery: () => Promise<void> }).runRecovery();

  beforeEach(() => {
    dataSource = createMockDataSource();
    queue = { publish: jest.fn().mockResolvedValue({ id: 'job-1' }) };
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

    it('parks a row as FAILED once max publish attempts are exhausted', async () => {
      const r = row({ publish_attempts: 9 }); // +1 → 10 === OUTBOX_MAX_ATTEMPTS default
      claimQb.getMany.mockResolvedValueOnce([r]);
      queue.publish.mockRejectedValueOnce(new Error('still down'));

      await drain();

      expect(markQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.FAILED, publish_attempts: 10 }),
      );
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
  });
});

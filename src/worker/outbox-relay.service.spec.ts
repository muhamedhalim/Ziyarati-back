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

describe('OutboxRelayService.drainBatch', () => {
  let service: OutboxRelayService;
  let dataSource: MockDataSource;
  let queue: { publish: jest.Mock };
  let qb: MockQueryBuilder;

  /** Invokes the private batch drainer directly (no interval/timer started). */
  const drain = () => (service as unknown as { drainBatch: () => Promise<void> }).drainBatch();

  beforeEach(() => {
    dataSource = createMockDataSource();
    queue = { publish: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    qb = createMockQueryBuilder();
    dataSource.manager.createQueryBuilder.mockReturnValue(qb);

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
    dedupe_key: 'dedupe-1',
    status: OutboxStatus.PENDING,
    publish_attempts: 0,
    published_at: null,
    last_error: null,
    ...overrides,
  });

  it('publishes a pending row and marks it PUBLISHED', async () => {
    const r = row();
    qb.getMany.mockResolvedValueOnce([r]);

    await drain();

    expect(queue.publish).toHaveBeenCalledWith(
      'analytics',
      'analytics.aggregate',
      expect.objectContaining({ tenantId: 't1', foo: 1 }),
      'dedupe-1',
    );
    expect(r.status).toBe(OutboxStatus.PUBLISHED);
    expect(r.published_at).toBeInstanceOf(Date);
    expect(dataSource.manager.save).toHaveBeenCalledWith(r);
  });

  it('keeps a row PENDING and records the error on a transient publish failure', async () => {
    const r = row();
    qb.getMany.mockResolvedValueOnce([r]);
    queue.publish.mockRejectedValueOnce(new Error('redis down'));

    await drain();

    expect(r.status).toBe(OutboxStatus.PENDING);
    expect(r.publish_attempts).toBe(1);
    expect(r.last_error).toBe('redis down');
  });

  it('parks a row as FAILED once max publish attempts are exhausted', async () => {
    const r = row({ publish_attempts: 9 }); // +1 → 10 === OUTBOX_MAX_ATTEMPTS default
    qb.getMany.mockResolvedValueOnce([r]);
    queue.publish.mockRejectedValueOnce(new Error('still down'));

    await drain();

    expect(r.publish_attempts).toBe(10);
    expect(r.status).toBe(OutboxStatus.FAILED);
  });

  it('does nothing when there are no pending rows', async () => {
    qb.getMany.mockResolvedValueOnce([]);
    await drain();
    expect(queue.publish).not.toHaveBeenCalled();
  });

  describe('lifecycle', () => {
    it('starts a polling timer on bootstrap and clears it on destroy', () => {
      jest.useFakeTimers();
      const setSpy = jest.spyOn(global, 'setInterval');
      const clearSpy = jest.spyOn(global, 'clearInterval');

      service.onApplicationBootstrap();
      expect(setSpy).toHaveBeenCalled();

      service.onModuleDestroy();
      expect(clearSpy).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('tick drains a batch and resets the running guard', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await (service as unknown as { tick: () => Promise<void> }).tick();
      expect((service as unknown as { running: boolean }).running).toBe(false);
    });

    it('tick swallows errors and still clears the running guard', async () => {
      qb.getMany.mockRejectedValueOnce(new Error('db down'));
      await (service as unknown as { tick: () => Promise<void> }).tick();
      expect((service as unknown as { running: boolean }).running).toBe(false);
    });
  });
});

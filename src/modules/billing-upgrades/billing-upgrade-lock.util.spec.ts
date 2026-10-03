import { lockRequest, lockRequestByPayment } from './billing-upgrade-lock.util';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import {
  createMockEntityManager,
  createMockQueryBuilder,
  createMockRepository,
  type MockRepository,
} from '../../../test/utils/mock-factories';

/**
 * The lock helpers exist because `findOne({ relations, lock })` — and a filter
 * through the nullable `payment` relation — fail on real Postgres with "FOR UPDATE
 * cannot be applied to the nullable side of an outer join". The mocked-repository
 * unit tests that preceded these never noticed (mocks do not execute SQL); a
 * real-Postgres e2e did. These tests pin the SHAPE that avoids it.
 */
describe('billing-upgrade lock helpers', () => {
  let repo: MockRepository;
  let manager: ReturnType<typeof createMockEntityManager>;

  beforeEach(() => {
    repo = createMockRepository();
    manager = createMockEntityManager(new Map([[BillingUpgradeRequest, repo]]));
  });

  describe('lockRequest', () => {
    it('locks the row ALONE — the locked read never carries a relation', async () => {
      repo.findOne
        .mockResolvedValueOnce({ id: 'r1' })
        .mockResolvedValueOnce({ id: 'r1', tenant: { id: 't1' } });

      await lockRequest(manager as never, { id: 'r1' }, { tenant: true });

      const [locked] = repo.findOne.mock.calls[0];
      expect(locked.lock).toEqual({ mode: 'pessimistic_write' });
      expect(locked.relations).toBeUndefined();
    });

    it('attaches the relations with a SECOND, UNLOCKED read of the same row', async () => {
      repo.findOne
        .mockResolvedValueOnce({ id: 'r1' })
        .mockResolvedValueOnce({ id: 'r1', tenant: { id: 't1' } });

      const row = await lockRequest(
        manager as never,
        { id: 'r1' },
        { tenant: true },
      );

      const [second] = repo.findOne.mock.calls[1];
      expect(second).toEqual({
        where: { id: 'r1' },
        relations: { tenant: true },
      });
      expect(second.lock).toBeUndefined();
      expect(row).toMatchObject({ id: 'r1', tenant: { id: 't1' } });
    });

    it('makes no second read when no relation is requested', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'r1' });
      await lockRequest(manager as never, { id: 'r1' });
      expect(repo.findOne).toHaveBeenCalledTimes(1);
    });

    it('returns null for a missing row without a second read', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        lockRequest(manager as never, { id: 'nope' }, { tenant: true }),
      ).resolves.toBeNull();
      expect(repo.findOne).toHaveBeenCalledTimes(1);
    });

    it('falls back to the locked row if the relations read comes back empty', async () => {
      repo.findOne
        .mockResolvedValueOnce({ id: 'r1', status: 'x' })
        .mockResolvedValueOnce(null);
      await expect(
        lockRequest(manager as never, { id: 'r1' }, { payment: true }),
      ).resolves.toMatchObject({ id: 'r1', status: 'x' });
    });

    it("passes the caller's where through unchanged (tenant scoping is preserved)", async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'r1' });
      await lockRequest(manager as never, { id: 'r1', tenant: { id: 't1' } });
      expect(repo.findOne.mock.calls[0][0].where).toEqual({
        id: 'r1',
        tenant: { id: 't1' },
      });
    });
  });

  describe('lockRequestByPayment', () => {
    const withLockResult = (row: unknown) => {
      const qb = createMockQueryBuilder();
      qb.getOne.mockResolvedValueOnce(row);
      repo.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    };

    it('filters on the raw "paymentId" column and never joins any table', async () => {
      const qb = withLockResult({ id: 'r1' });

      await lockRequestByPayment(manager as never, 'pay-1');

      expect(qb.where).toHaveBeenCalledWith(
        'request."paymentId" = :paymentId',
        {
          paymentId: 'pay-1',
        },
      );
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(qb.innerJoin).not.toHaveBeenCalled();
      expect(qb.innerJoinAndSelect).not.toHaveBeenCalled();
      expect(qb.leftJoin).not.toHaveBeenCalled();
      expect(qb.leftJoinAndSelect).not.toHaveBeenCalled();
    });

    it('never uses the find-options lock path (the one Postgres refuses with a relation)', async () => {
      withLockResult({ id: 'r1' });
      repo.findOne.mockResolvedValueOnce({ id: 'r1', tenant: { id: 't1' } });

      await lockRequestByPayment(manager as never, 'pay-1', { tenant: true });

      for (const [options] of repo.findOne.mock.calls) {
        expect(options.lock).toBeUndefined();
      }
    });

    it('loads relations with an UNLOCKED second read', async () => {
      withLockResult({ id: 'r1' });
      repo.findOne.mockResolvedValueOnce({ id: 'r1', tenant: { id: 't1' } });

      const row = await lockRequestByPayment(manager as never, 'pay-1', {
        tenant: true,
      });

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'r1' },
        relations: { tenant: true },
      });
      expect(row).toMatchObject({ tenant: { id: 't1' } });
    });

    it('returns null when no request is linked to the payment (a normal add-on / booking payment)', async () => {
      withLockResult(null);
      await expect(
        lockRequestByPayment(manager as never, 'pay-1', { tenant: true }),
      ).resolves.toBeNull();
      expect(repo.findOne).not.toHaveBeenCalled();
    });
  });
});

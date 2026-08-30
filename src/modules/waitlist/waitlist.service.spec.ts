import { WaitlistService } from './waitlist.service';
import { WaitlistOfferState, WaitlistState } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';

function mockQueryBuilder(affected = 1) {
  const qb: any = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected }),
  };
  return qb;
}

describe('WaitlistService (T156)', () => {
  const build = () => {
    const entries: any = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve({ id: 'entry-1', ...x })),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => mockQueryBuilder(1)),
    };
    const offers: any = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => mockQueryBuilder(1)),
    };
    const customers: any = { exists: jest.fn().mockResolvedValue(true) };
    const services: any = { exists: jest.fn().mockResolvedValue(true) };
    const staff: any = { exists: jest.fn().mockResolvedValue(true) };
    const branches: any = { exists: jest.fn().mockResolvedValue(true) };

    const svc = new WaitlistService(
      entries,
      offers,
      customers,
      services,
      staff,
      branches,
    );
    return { svc, entries, offers, customers, services, staff, branches };
  };

  describe('create', () => {
    it('creates a WAITING entry with expires_at pinned to windowEnd', async () => {
      const { svc, entries } = build();
      const dto = {
        customerId: 'c1',
        serviceId: 's1',
        windowEnd: '2031-01-02T00:00:00.000Z',
      };
      await svc.create('t1', dto as never);
      expect(entries.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: WaitlistState.WAITING,
          expires_at: new Date(dto.windowEnd),
        }),
      );
    });

    it('rejects when the customer does not belong to the tenant (404)', async () => {
      const { svc, customers } = build();
      customers.exists.mockResolvedValue(false);
      await expect(
        svc.create('t1', { customerId: 'c1', serviceId: 's1' } as never),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('rejects windowEnd <= windowStart (422)', async () => {
      const { svc } = build();
      await expect(
        svc.create('t1', {
          customerId: 'c1',
          serviceId: 's1',
          windowStart: '2031-01-02T00:00:00.000Z',
          windowEnd: '2031-01-01T00:00:00.000Z',
        } as never),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('lets a duplicate-active-entry DB constraint violation propagate uncaught (mapped to 409 by the global filter, not pre-checked here)', async () => {
      const { svc, entries } = build();
      const dbErr = new Error('duplicate key value violates unique constraint');
      entries.save.mockRejectedValueOnce(dbErr);
      await expect(
        svc.create('t1', { customerId: 'c1', serviceId: 's1' } as never),
      ).rejects.toBe(dbErr);
    });
  });

  describe('update / cancel — terminal-state guard', () => {
    const terminalEntry = (state: WaitlistState) => ({
      id: 'e1',
      state,
      tenant: { id: 't1' },
    });

    it('update refuses a terminal entry with 409', async () => {
      const { svc, entries } = build();
      entries.findOne.mockResolvedValue(terminalEntry(WaitlistState.FULFILLED));
      await expect(
        svc.update('t1', 'e1', { priority: 5 } as never),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('cancel refuses an already-cancelled entry with 409', async () => {
      const { svc, entries } = build();
      entries.findOne.mockResolvedValue(terminalEntry(WaitlistState.CANCELLED));
      await expect(svc.cancel('t1', 'e1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('cancel withdraws any live PENDING offer and sets the entry CANCELLED', async () => {
      const { svc, entries, offers } = build();
      entries.findOne.mockResolvedValue({
        id: 'e1',
        state: WaitlistState.OFFERED,
        tenant: { id: 't1' },
      });
      const offersQb = mockQueryBuilder(1);
      offers.createQueryBuilder.mockReturnValue(offersQb);

      const result = await svc.cancel('t1', 'e1');

      expect(offersQb.set).toHaveBeenCalledWith({
        state: WaitlistOfferState.WITHDRAWN,
      });
      expect(entries.save).toHaveBeenCalledWith(
        expect.objectContaining({ state: WaitlistState.CANCELLED }),
      );
      expect(result.state).toBe(WaitlistState.CANCELLED);
    });
  });

  describe('expireDueEntries (FR-W004 sweep)', () => {
    it('runs a bulk conditional UPDATE scoped to WAITING + a passed expires_at, returns the affected count', async () => {
      const { svc, entries } = build();
      const qb = mockQueryBuilder(4);
      entries.createQueryBuilder.mockReturnValue(qb);

      const count = await svc.expireDueEntries();

      expect(qb.set).toHaveBeenCalledWith({ state: WaitlistState.EXPIRED });
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('state = :waiting'),
        expect.objectContaining({ waiting: WaitlistState.WAITING }),
      );
      expect(count).toBe(4);
    });
  });
});

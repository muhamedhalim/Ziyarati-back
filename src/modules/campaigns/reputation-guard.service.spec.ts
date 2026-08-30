import { ReputationGuardService } from './reputation-guard.service';
import { AppError } from '../../common/errors';

function makeQueryBuilder(count: number) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['innerJoin', 'where', 'andWhere']) qb[m] = jest.fn(() => qb);
  qb.getCount = jest.fn().mockResolvedValue(count);
  return qb;
}

describe('ReputationGuardService (T135, FR-E019)', () => {
  let service: ReputationGuardService;
  let recipients: { createQueryBuilder: jest.Mock };
  let suppressions: { count: jest.Mock };

  function setup(sent: number, bounced: number, complained: number) {
    recipients = { createQueryBuilder: jest.fn(() => makeQueryBuilder(sent)) };
    suppressions = {
      count: jest
        .fn()
        .mockImplementation(({ where }: { where: { reason: string } }) =>
          Promise.resolve(where.reason === 'BOUNCE' ? bounced : complained),
        ),
    };
    service = new ReputationGuardService(
      suppressions as never,
      recipients as never,
    );
  }

  it('does not suspend a clean sender', async () => {
    setup(100, 1, 0);
    const snap = await service.snapshot('t1');
    expect(snap).toMatchObject({ suspended: false });
  });

  it('suspends when the bounce rate breaches the threshold with a large enough sample', async () => {
    setup(100, 15, 0); // 15% bounce
    const snap = await service.snapshot('t1');
    expect(snap.suspended).toBe(true);
    expect(snap.reason).toContain('bounce rate');
  });

  it('suspends when the complaint rate breaches the threshold', async () => {
    setup(100, 0, 8); // 8% complaint
    const snap = await service.snapshot('t1');
    expect(snap.suspended).toBe(true);
    expect(snap.reason).toContain('complaint rate');
  });

  it('does NOT suspend on a tiny sample even at a high nominal rate (avoids noise on a new/small list)', async () => {
    setup(5, 2, 0); // 40% bounce, but only 5 sends
    const snap = await service.snapshot('t1');
    expect(snap.suspended).toBe(false);
  });

  it('reports zero rates and no suspension when nothing has been sent yet', async () => {
    setup(0, 0, 0);
    const snap = await service.snapshot('t1');
    expect(snap).toMatchObject({
      sent: 0,
      bounceRate: 0,
      complaintRate: 0,
      suspended: false,
    });
  });

  describe('assertNotSuspended', () => {
    it('resolves without throwing for a healthy tenant', async () => {
      setup(100, 1, 0);
      await expect(service.assertNotSuspended('t1')).resolves.toBeUndefined();
    });

    it('throws (blocking dispatch) for a suspended tenant, and logs an "ALERT" for the platform', async () => {
      setup(100, 20, 0);
      const errorSpy = jest.spyOn((service as any).logger, 'error');

      await expect(service.assertNotSuspended('t1')).rejects.toBeInstanceOf(
        AppError,
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ALERT'));
    });
  });
});

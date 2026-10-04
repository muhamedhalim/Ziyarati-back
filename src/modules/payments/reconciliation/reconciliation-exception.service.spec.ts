import {
  detailsHash,
  ReconciliationExceptionService,
} from './reconciliation-exception.service';
import { ErrorCode } from '../../../common/errors';

const ID = '11111111-1111-4111-8111-111111111111';

describe('detailsHash', () => {
  it('does not depend on key order, at any depth', () => {
    expect(detailsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      detailsHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
  it('changes when a value changes', () => {
    expect(detailsHash({ amount: 10 })).not.toBe(detailsHash({ amount: 11 }));
  });
  it('is sensitive to array order and to extra keys', () => {
    expect(detailsHash({ ids: ['a', 'b'] })).not.toBe(
      detailsHash({ ids: ['b', 'a'] }),
    );
    expect(detailsHash({ a: 1 })).not.toBe(detailsHash({ a: 1, b: null }));
  });
  it('is a sha256 hex digest', () => {
    expect(detailsHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ReconciliationExceptionService', () => {
  let repo: any;
  let manager: { query: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let audit: { record: jest.Mock };
  let service: ReconciliationExceptionService;
  let alerts: string[];

  const input = (over: Record<string, unknown> = {}): any => ({
    kind: 'UNKNOWN_CHARGE',
    provider: 'tap',
    objectId: 'chg_1',
    tenantId: 't1',
    details: { amount: 10 },
    ...over,
  });

  beforeEach(() => {
    manager = { query: jest.fn() };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb(manager)),
      query: jest.fn(),
    };
    const qb: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ status: 'OPEN', count: '3' }]),
    };
    repo = {
      findOne: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[{ id: ID }], 1]),
      createQueryBuilder: jest.fn(() => qb),
      qb,
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ReconciliationExceptionService(
      repo,
      dataSource as any,
      audit as any,
    );
    alerts = [];
    jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation((m: any) => alerts.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  describe('raise', () => {
    it('a NEW discrepancy is inserted, reported as created, and alerted', async () => {
      manager.query.mockResolvedValueOnce([{ id: ID }]); // INSERT … RETURNING id

      expect(await service.raise(input())).toEqual({
        created: true,
        reopened: false,
      });
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query.mock.calls[0][0]).toContain(
        'ON CONFLICT (kind, provider_object_id) DO NOTHING',
      );
      expect(manager.query.mock.calls[0][1].slice(0, 6)).toEqual([
        'UNKNOWN_CHARGE',
        'tap',
        'chg_1',
        't1',
        null,
        null,
      ]);
      expect(alerts.join(' ')).toMatch(
        /ALERT: reconciliation exception UNKNOWN_CHARGE/,
      );
    });

    it('re-finding an OPEN one bumps the counter and is NOT news (no alert, not reopened)', async () => {
      manager.query
        .mockResolvedValueOnce([]) // INSERT conflicted
        .mockResolvedValueOnce([
          { id: ID, status: 'OPEN', details_hash: detailsHash({ amount: 10 }) },
        ])
        .mockResolvedValueOnce([]); // UPDATE

      expect(await service.raise(input())).toEqual({
        created: false,
        reopened: false,
      });
      expect(manager.query.mock.calls[1][0]).toContain('FOR UPDATE');
      expect(manager.query.mock.calls[2][0]).toContain(
        'occurrences = occurrences + 1',
      );
      expect(alerts).toEqual([]);
    });

    it('a CLOSED one with the SAME facts stays closed', async () => {
      manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: ID,
            status: 'IGNORED',
            details_hash: detailsHash({ amount: 10 }),
          },
        ])
        .mockResolvedValueOnce([]);

      expect(await service.raise(input())).toEqual({
        created: false,
        reopened: false,
      });
      expect(manager.query.mock.calls[2][1][6]).toBe(false); // the `reopen` flag
      expect(alerts).toEqual([]);
    });

    it('a CLOSED one whose facts CHANGED is reopened, and alerted', async () => {
      manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: ID,
            status: 'RESOLVED',
            details_hash: detailsHash({ amount: 10 }),
          },
        ])
        .mockResolvedValueOnce([]);

      expect(await service.raise(input({ details: { amount: 12 } }))).toEqual({
        created: false,
        reopened: true,
      });
      expect(manager.query.mock.calls[2][1][6]).toBe(true);
      expect(alerts.join(' ')).toMatch(/reopened/);
    });

    it('is atomic: the whole decision runs in ONE transaction', async () => {
      manager.query.mockResolvedValueOnce([{ id: ID }]);
      await service.raise(input());
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('raiseQuietly', () => {
    it('never throws — recording a discrepancy must not fail the work it rides on', async () => {
      dataSource.transaction.mockRejectedValue(new Error('db down'));
      const warn = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
      await expect(service.raiseQuietly(input())).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('autoResolve', () => {
    it('closes only an OPEN row, and says whether it did (tuple or plain rows)', async () => {
      dataSource.query.mockResolvedValueOnce([[{ id: ID }], 1]);
      expect(
        await service.autoResolve(
          'REPORTS_UNREACHABLE' as any,
          'm1',
          'reachable',
        ),
      ).toBe(true);
      expect(dataSource.query.mock.calls[0][0]).toContain("status = 'OPEN'");

      dataSource.query.mockResolvedValueOnce([[], 0]);
      expect(
        await service.autoResolve(
          'REPORTS_UNREACHABLE' as any,
          'm1',
          'reachable',
        ),
      ).toBe(false);

      dataSource.query.mockResolvedValueOnce([{ id: ID }]);
      expect(
        await service.autoResolve(
          'REPORTS_UNREACHABLE' as any,
          'm1',
          'reachable',
        ),
      ).toBe(true);
    });
  });

  describe('list', () => {
    it('applies only the filters given, newest sighting first, and returns counts by status', async () => {
      const res = await service.list({
        status: 'OPEN',
        kind: 'UNKNOWN_CHARGE',
        tenantId: 't1',
        page: 2,
        limit: 10,
      });
      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: { status: 'OPEN', kind: 'UNKNOWN_CHARGE', tenant_id: 't1' },
        order: { last_seen_at: 'DESC' },
        skip: 10,
        take: 10,
      });
      expect(res).toMatchObject({
        total: 1,
        page: 2,
        limit: 10,
        counts: { OPEN: 3 },
      });

      await service.list({ page: 1, limit: 20 });
      expect(repo.findAndCount.mock.calls[1][0].where).toEqual({});
    });

    it("names the clinic on each row — one query for the page, none when no row has a clinic", async () => {
      repo.findAndCount.mockResolvedValueOnce([
        [
          { id: 'e1', tenant_id: 't1' },
          { id: 'e2', tenant_id: 't1' },
          { id: 'e3', tenant_id: null },
        ],
        3,
      ]);
      dataSource.query.mockResolvedValueOnce([{ id: 't1', name: 'Clinic One' }]);

      const res = await service.list({ page: 1, limit: 20 });

      expect(res.data).toEqual([
        { id: 'e1', tenant_id: 't1', tenant_name: 'Clinic One' },
        { id: 'e2', tenant_id: 't1', tenant_name: 'Clinic One' },
        { id: 'e3', tenant_id: null, tenant_name: null },
      ]);
      expect(dataSource.query).toHaveBeenCalledTimes(1);
      expect(dataSource.query.mock.calls[0][1]).toEqual([['t1']]);

      dataSource.query.mockClear();
      repo.findAndCount.mockResolvedValueOnce([[{ id: 'e4', tenant_id: null }], 1]);
      await service.list({ page: 1, limit: 20 });
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('detail', () => {
    it('is the row plus the clinic name; an unknown id is a 404', async () => {
      repo.findOne.mockResolvedValueOnce({ id: ID, tenant_id: 't9' });
      dataSource.query.mockResolvedValueOnce([{ id: 't9', name: 'Nine' }]);
      await expect(service.detail(ID)).resolves.toEqual({
        id: ID,
        tenant_id: 't9',
        tenant_name: 'Nine',
      });

      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.detail(ID)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('close', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: ID,
      kind: 'UNKNOWN_CHARGE',
      provider_object_id: 'chg_1',
      tenant_id: 't1',
      status: 'OPEN',
      ...over,
    });

    it('IGNORED needs a note; RESOLVED does not', async () => {
      repo.findOne.mockResolvedValue(row());
      await expect(
        service.close(ID, 'a', 'IGNORED', '   '),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      await expect(service.close(ID, 'a', 'RESOLVED')).resolves.toBeDefined();
    });

    it('closing an OPEN row is conditional on it still being OPEN, and is audited with the actor and tenant', async () => {
      repo.findOne.mockResolvedValue(row());
      await service.close(ID, 'admin-1', 'IGNORED', ' not ours ');

      expect(repo.qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'IGNORED',
          resolved_by: 'admin-1',
          resolution_note: 'not ours',
        }),
      );
      expect(repo.qb.where).toHaveBeenCalledWith(
        'id = :id AND status = :open',
        { id: ID, open: 'OPEN' },
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.reconciliation.exception_ignored',
          userId: 'admin-1',
          entityType: 'payment_reconciliation_exception',
          entityId: ID,
          tenantId: 't1',
          after: expect.objectContaining({
            status: 'IGNORED',
            note: 'not ours',
          }),
        }),
      );
    });

    it('is idempotent for the same outcome and refuses the other', async () => {
      repo.findOne.mockResolvedValue(row({ status: 'RESOLVED' }));
      await expect(service.close(ID, 'a', 'RESOLVED')).resolves.toMatchObject({
        status: 'RESOLVED',
      });
      expect(repo.qb.execute).not.toHaveBeenCalled();
      await expect(
        service.close(ID, 'a', 'IGNORED', 'why'),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('two operators closing at once: the loser gets a conflict, not a second audit row', async () => {
      repo.findOne.mockResolvedValue(row());
      repo.qb.execute.mockResolvedValue({ affected: 0 });
      await expect(service.close(ID, 'a', 'RESOLVED')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an unknown id is a 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.close(ID, 'a', 'RESOLVED')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('checkDuplicateBookingCapture', () => {
    const live = (
      id: string,
      gw: string | null,
      over: Record<string, unknown> = {},
    ) => ({
      id,
      tenant_id: 't1',
      gateway: 'tap',
      gateway_payment_id: gw,
      amount: '250.00',
      appointment_id: 'appt-1',
      ...over,
    });

    it('one live payment (or none) is not a duplicate', async () => {
      dataSource.query.mockResolvedValue([live('p1', 'chg_1')]);
      expect(await service.checkDuplicateBookingCapture('p1')).toBe(0);
      dataSource.query.mockResolvedValue([]);
      expect(await service.checkDuplicateBookingCapture('p1')).toBe(0);
    });

    it('only PAID / PARTIALLY_REFUNDED booking payments for the same appointment count, earliest first', async () => {
      dataSource.query.mockResolvedValue([]);
      await service.checkDuplicateBookingCapture('p1');
      const sql = String(dataSource.query.mock.calls[0][0]);
      expect(sql).toContain("p.status IN ('PAID', 'PARTIALLY_REFUNDED')");
      expect(sql).toContain("p.purpose IN ('BOOKING', 'MANUAL')");
      expect(sql).toContain('ORDER BY p.paid_at ASC NULLS LAST, p.id ASC');
    });

    it('raises DUPLICATE_CAPTURE for every payment after the first, keyed by the gateway charge id', async () => {
      dataSource.query.mockResolvedValue([
        live('p1', 'chg_1'),
        live('p2', 'chg_2'),
        live('p3', null),
      ]);
      const raise = jest
        .spyOn(service, 'raiseQuietly')
        .mockResolvedValue(undefined);

      expect(await service.checkDuplicateBookingCapture('p2')).toBe(2);

      expect(raise).toHaveBeenCalledTimes(2);
      expect(raise.mock.calls[0][0]).toMatchObject({
        kind: 'DUPLICATE_CAPTURE',
        provider: 'tap',
        objectId: 'chg_2',
        paymentId: 'p2',
        tenantId: 't1',
        details: {
          reference: 'appt-1',
          firstChargeId: 'chg_1',
          livePaymentIds: ['p1', 'p2', 'p3'],
        },
      });
      // a payment with no gateway id falls back to its own id
      expect(raise.mock.calls[1][0].objectId).toBe('p3');
    });
  });
});

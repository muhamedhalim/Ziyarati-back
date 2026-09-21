import { CUSTOMER_EVENT } from '../../events/customer.events';
import {
  BirthdayGreetingSweepService,
  localClock,
} from './birthday-greeting.sweep.service';
import {
  BIRTHDAY_SEND_LOCAL_HOUR,
  WORKFLOW_TRIGGER,
} from './workflow.constants';

describe('localClock', () => {
  it('reads an instant as wall-clock time in the given IANA zone', () => {
    // 2026-03-14 06:10 UTC is 09:10 in Riyadh (UTC+3, no DST).
    expect(localClock(new Date('2026-03-14T06:10:00Z'), 'Asia/Riyadh')).toEqual(
      { year: 2026, month: 3, day: 14, hour: 9 },
    );
  });

  it('rolls the calendar date across midnight for a zone ahead of UTC', () => {
    // 22:30 UTC on 14 Mar is already 15 Mar 00:30 in Riyadh.
    expect(localClock(new Date('2026-03-14T22:30:00Z'), 'Asia/Riyadh')).toEqual(
      { year: 2026, month: 3, day: 15, hour: 1 },
    );
  });

  it('never reports hour 24 at local midnight', () => {
    expect(localClock(new Date('2026-03-14T00:05:00Z'), 'UTC').hour).toBe(0);
  });

  it('falls back to UTC for an invalid zone instead of throwing', () => {
    expect(localClock(new Date('2026-03-14T06:10:00Z'), 'Not/AZone')).toEqual({
      year: 2026,
      month: 3,
      day: 14,
      hour: 6,
    });
  });
});

describe('BirthdayGreetingSweepService', () => {
  const T1 = 'tenant-1';
  const T2 = 'tenant-2';
  // 06:10 UTC = 09:10 in Asia/Riyadh (the send hour) and 06:10 in UTC.
  const NOW = new Date('2026-03-14T06:10:00Z');

  let dataSource: { query: jest.Mock };
  let events: { emitAsync: jest.Mock };
  let access: { resolve: jest.Mock; shouldBlock: jest.Mock };
  let service: BirthdayGreetingSweepService;

  /** Routes the two SQL shapes the sweep issues. */
  const wire = (
    tenants: Array<{ id: string; tz: string | null }>,
    customersByTenant: Record<string, string[]> = {},
  ) => {
    dataSource.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM workflows w')) return Promise.resolve(tenants);
      if (sql.includes('FROM customers c')) {
        const ids = customersByTenant[params[0] as string] ?? [];
        return Promise.resolve(ids.map((id) => ({ id })));
      }
      return Promise.resolve([]);
    });
  };

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    events = { emitAsync: jest.fn().mockResolvedValue([]) };
    access = {
      resolve: jest.fn().mockResolvedValue({ allowed: true }),
      shouldBlock: jest.fn().mockReturnValue(true),
    };
    service = new BirthdayGreetingSweepService(
      dataSource as never,
      events as never,
      access as never,
    );
  });

  it('only looks for tenants with an ACTIVE workflow on the birthday trigger', async () => {
    wire([]);
    await service.sweep(NOW);
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('w.is_active = true');
    expect(sql).toContain('t.is_active = true');
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(params).toEqual([WORKFLOW_TRIGGER.CUSTOMER_BIRTHDAY]);
  });

  it('greets each matching patient once, emitting customer.birthday with the clinic-local date', async () => {
    wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: ['c1', 'c2'] });

    const res = await service.sweep(NOW);

    expect(res).toEqual({ tenants: 1, processed: 1, emitted: 2 });
    expect(events.emitAsync).toHaveBeenCalledTimes(2);
    expect(events.emitAsync).toHaveBeenNthCalledWith(
      1,
      CUSTOMER_EVENT.BIRTHDAY,
      expect.objectContaining({
        tenantId: T1,
        customerId: 'c1',
        occurrenceDate: '2026-03-14',
      }),
    );
  });

  it('does nothing for a tenant whose local time is NOT the send hour', async () => {
    // America/New_York is 02:10 (or 01:10) at this instant.
    wire([{ id: T1, tz: 'America/New_York' }], { [T1]: ['c1'] });

    const res = await service.sweep(NOW);

    expect(res).toEqual({ tenants: 1, processed: 0, emitted: 0 });
    expect(events.emitAsync).not.toHaveBeenCalled();
    // ...and never even queried that tenant's patients.
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        String(sql).includes('FROM customers c'),
      ),
    ).toBe(false);
    expect(BIRTHDAY_SEND_LOCAL_HOUR).toBe(9);
  });

  it('treats a tenant with no timezone as UTC', async () => {
    wire([{ id: T1, tz: null }], { [T1]: ['c1'] });
    // 09:10 UTC is the send hour for a UTC clinic.
    const res = await service.sweep(new Date('2026-03-14T09:10:00Z'));
    expect(res.emitted).toBe(1);
  });

  it('scopes every patient query to the tenant being processed (tenant isolation)', async () => {
    wire(
      [
        { id: T1, tz: 'Asia/Riyadh' },
        { id: T2, tz: 'Asia/Riyadh' },
      ],
      { [T1]: ['a1'], [T2]: ['b1', 'b2'] },
    );

    await service.sweep(NOW);

    const customerCalls = dataSource.query.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM customers c'),
    );
    expect(customerCalls.map(([, p]) => p[0])).toEqual([T1, T2]);
    for (const [sql] of customerCalls) {
      expect(sql).toContain('c."tenantId" = $1');
    }
    const byTenant = events.emitAsync.mock.calls.map(([, e]) => [
      e.tenantId,
      e.customerId,
    ]);
    expect(byTenant).toEqual([
      [T1, 'a1'],
      [T2, 'b1'],
      [T2, 'b2'],
    ]);
  });

  it('excludes deleted, inactive, opted-out, phone-less and DOB-less patients in SQL', async () => {
    wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: ['c1'] });
    await service.sweep(NOW);
    const sql: string = dataSource.query.mock.calls.find(([s]) =>
      String(s).includes('FROM customers c'),
    )![0];
    expect(sql).toContain('c.deleted_at IS NULL');
    expect(sql).toContain('c.is_active = true');
    expect(sql).toContain('c.opted_out_at IS NULL');
    expect(sql).toContain('c.date_of_birth IS NOT NULL');
    expect(sql).toContain("COALESCE(BTRIM(c.phone), '') <> ''");
  });

  it('matches the clinic-local month/day', async () => {
    wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: ['c1'] });
    await service.sweep(NOW);
    const params = dataSource.query.mock.calls.find(([s]) =>
      String(s).includes('FROM customers c'),
    )![1];
    // [tenantId, month, day, includeLeapDay, afterId, pageSize]
    expect(params.slice(0, 4)).toEqual([T1, 3, 14, false]);
  });

  describe('29 February birthdays', () => {
    // 28 Feb 2026 (non-leap) 09:10 in Riyadh = 06:10 UTC.
    it('are greeted on 28 Feb in a non-leap year', async () => {
      wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: ['leap'] });
      await service.sweep(new Date('2026-02-28T06:10:00Z'));
      const params = dataSource.query.mock.calls.find(([s]) =>
        String(s).includes('FROM customers c'),
      )![1];
      expect(params.slice(0, 4)).toEqual([T1, 2, 28, true]);
    });

    it('are NOT pulled forward to 28 Feb in a leap year (they have a real 29 Feb)', async () => {
      wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: [] });
      await service.sweep(new Date('2028-02-28T06:10:00Z'));
      const params = dataSource.query.mock.calls.find(([s]) =>
        String(s).includes('FROM customers c'),
      )![1];
      expect(params.slice(0, 4)).toEqual([T1, 2, 28, false]);
    });
  });

  describe('tenant access control', () => {
    it('skips a tenant that is not entitled to automations (no patients queried, nothing emitted)', async () => {
      wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: ['c1'] });
      access.resolve.mockResolvedValue({ allowed: false });
      access.shouldBlock.mockReturnValue(true);

      const res = await service.sweep(NOW);

      expect(access.resolve).toHaveBeenCalledWith(T1, 'automations');
      expect(res).toEqual({ tenants: 1, processed: 0, emitted: 0 });
      expect(events.emitAsync).not.toHaveBeenCalled();
    });

    it('still proceeds when a denial is only being OBSERVED (shadow mode), matching every other enforcement point', async () => {
      wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: ['c1'] });
      access.resolve.mockResolvedValue({ allowed: false });
      access.shouldBlock.mockReturnValue(false);

      const res = await service.sweep(NOW);

      expect(res.emitted).toBe(1);
      expect(access.shouldBlock).toHaveBeenCalledWith(
        { allowed: false },
        { surface: 'worker', detail: 'workflow.birthdaySweep' },
      );
    });
  });

  describe('resilience', () => {
    it('one failing tenant does not stop the others', async () => {
      wire(
        [
          { id: T1, tz: 'Asia/Riyadh' },
          { id: T2, tz: 'Asia/Riyadh' },
        ],
        { [T2]: ['b1'] },
      );
      access.resolve.mockImplementation((tenantId: string) =>
        tenantId === T1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ allowed: true }),
      );

      const res = await service.sweep(NOW);

      expect(res).toEqual({ tenants: 2, processed: 1, emitted: 1 });
    });

    it('aborts, without emitting further, when keepAlive reports the lock was lost', async () => {
      wire([{ id: T1, tz: 'Asia/Riyadh' }], { [T1]: ['c1'] });
      const keepAlive = jest.fn().mockResolvedValue(false);

      const res = await service.sweep(NOW, { keepAlive });

      expect(keepAlive).toHaveBeenCalledTimes(1);
      expect(res.emitted).toBe(0);
      expect(events.emitAsync).not.toHaveBeenCalled();
    });

    it('pages through many same-day birthdays instead of loading them all at once', async () => {
      const page1 = Array.from({ length: 500 }, (_, i) => `p1-${i}`);
      const page2 = ['p2-0', 'p2-1'];
      let customerCall = 0;
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM workflows w'))
          return Promise.resolve([{ id: T1, tz: 'Asia/Riyadh' }]);
        customerCall += 1;
        return Promise.resolve(
          (customerCall === 1 ? page1 : page2).map((id) => ({ id })),
        );
      });

      const res = await service.sweep(NOW);

      expect(res.emitted).toBe(502);
      // Second page is keyed off the last id of the first (keyset pagination).
      const secondParams = dataSource.query.mock.calls.filter(([s]) =>
        String(s).includes('FROM customers c'),
      )[1][1];
      expect(secondParams[4]).toBe('p1-499');
    });
  });
});

import { NotificationRulesSweepService } from './notification-rules.sweep.service';

const TENANT = 't1';

/** 10:00 in Asia/Riyadh (UTC+3) is 07:00Z. */
const AT_10_RIYADH = new Date('2026-10-24T07:00:00Z');
const AT_15_RIYADH = new Date('2026-10-24T12:00:00Z');

describe('NotificationRulesSweepService — patient re-engagement', () => {
  let dataSource: { query: jest.Mock };
  let scheduler: { schedule: jest.Mock };
  let library: { recordRun: jest.Mock; timezoneOf: jest.Mock };
  let access: { resolve: jest.Mock; shouldBlock: jest.Mock };
  let service: NotificationRulesSweepService;

  const dueRule = (over: Record<string, unknown> = {}) => ({
    id: 'rule-6',
    tenantId: TENANT,
    templateId: 'nt-1',
    conditions: { inactivityDays: 180, cooldownDays: 90, dailyCap: 100 },
    tz: 'Asia/Riyadh',
    ...over,
  });

  /** Routes the three kinds of query the sweep makes. */
  const db = (opts: {
    rules?: unknown[];
    today?: number;
    pages?: Array<Array<{ id: string }>>;
  }) => {
    const pages = [...(opts.pages ?? [[]])];
    dataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM notification_rules'))
        return Promise.resolve(opts.rules ?? [dueRule()]);
      if (sql.includes('COUNT(*)'))
        return Promise.resolve([{ n: opts.today ?? 0 }]);
      return Promise.resolve(pages.shift() ?? []);
    });
  };

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    scheduler = { schedule: jest.fn().mockResolvedValue({ id: 's' }) };
    library = {
      recordRun: jest.fn().mockResolvedValue(undefined),
      timezoneOf: jest.fn().mockResolvedValue('Asia/Riyadh'),
    };
    access = {
      resolve: jest.fn().mockResolvedValue({ allowed: true }),
      shouldBlock: jest.fn().mockReturnValue(false),
    };
    service = new NotificationRulesSweepService(
      dataSource as never,
      scheduler as never,
      library as never,
      access as never,
    );
  });

  const candidateSql = () =>
    dataSource.query.mock.calls
      .map((c) => c[0] as string)
      .find((s) => s.includes('FROM customers c'))!;

  it('only visits clinics that have the rule ENABLED', async () => {
    db({ rules: [] });
    const out = await service.sweep(AT_10_RIYADH);
    expect(out).toEqual({ tenants: 0, processed: 0, scheduled: 0 });
    const ruleQuery = dataSource.query.mock.calls[0][0] as string;
    expect(ruleQuery).toContain('r.is_active = true');
    expect(ruleQuery).toContain('t.is_active = true');
    expect(dataSource.query.mock.calls[0][1]).toEqual([
      ['patient_reengagement', 'followup_due'],
    ]);
  });

  it("acts at the clinic's local hour, and not at any other", async () => {
    db({ pages: [[{ id: 'c1' }]] });
    expect((await service.sweep(AT_10_RIYADH)).scheduled).toBe(1);

    db({ pages: [[{ id: 'c1' }]] });
    expect((await service.sweep(AT_15_RIYADH)).processed).toBe(0);
  });

  it('skips a clinic whose rule has no template yet', async () => {
    db({ rules: [dueRule({ templateId: null })], pages: [[{ id: 'c1' }]] });
    expect((await service.sweep(AT_10_RIYADH)).scheduled).toBe(0);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('skips a clinic that is no longer entitled to notifications', async () => {
    access.resolve.mockResolvedValue({ allowed: false });
    access.shouldBlock.mockReturnValue(true);
    db({ pages: [[{ id: 'c1' }]] });
    const out = await service.sweep(AT_10_RIYADH);
    expect(out.processed).toBe(0);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  describe('who is selected', () => {
    it('only consenting, active, reachable, lapsed patients with no upcoming visit', async () => {
      db({ pages: [[{ id: 'c1' }]] });
      await service.sweep(AT_10_RIYADH);
      const sql = candidateSql();
      expect(sql).toContain('c."tenantId" = $1');
      expect(sql).toContain('c.marketing_opt_in = true'); // consent
      expect(sql).toContain('c.opted_out_at IS NULL'); // not opted out
      expect(sql).toContain('c.deleted_at IS NULL');
      expect(sql).toContain('c.is_active = true');
      expect(sql).toMatch(/BTRIM\(c\.phone\)/); // has a phone
      expect(sql).toContain("a.status = 'COMPLETED'"); // has visited at some point
      expect(sql).toContain(
        "a.status IN ('CONFIRMED','PENDING_PAYMENT','IN_PROGRESS') AND a.start_at > now()",
      ); // none upcoming
      expect(sql).toContain("interval '1 day'"); // inactivity window
    });

    it('applies the clinic-set inactivity and cooldown, and excludes this rule’s recent recipients', async () => {
      db({
        rules: [
          dueRule({
            conditions: { inactivityDays: 365, cooldownDays: 30, dailyCap: 10 },
          }),
        ],
        pages: [[{ id: 'c1' }]],
      });
      await service.sweep(AT_10_RIYADH);
      const call = dataSource.query.mock.calls.find((c) =>
        (c[0] as string).includes('FROM customers c'),
      )!;
      const [tenant, inactivity, ruleId, cooldown] = call[1];
      expect([tenant, inactivity, ruleId, cooldown]).toEqual([
        TENANT,
        365,
        'rule-6',
        30,
      ]);
      expect(call[0]).toContain(
        'n.notification_rule_id = $3 AND n.recipient_id = c.id',
      );
    });

    it('every query is scoped to the rule’s own tenant', async () => {
      db({ pages: [[{ id: 'c1' }]] });
      await service.sweep(AT_10_RIYADH);
      const scoped = dataSource.query.mock.calls.filter(
        (c) =>
          (c[0] as string).includes('FROM customers c') ||
          (c[0] as string).includes('COUNT(*)'),
      );
      for (const [, params] of scoped)
        expect((params as unknown[])[0]).toBe(TENANT);
    });
  });

  describe('what it schedules', () => {
    it('one row per patient with a deterministic key per cooldown period, linked to the rule', async () => {
      db({ pages: [[{ id: 'c1' }, { id: 'c2' }]] });
      const out = await service.sweep(AT_10_RIYADH);

      expect(out.scheduled).toBe(2);
      const refs = scheduler.schedule.mock.calls.map((c) => c[2] as string);
      expect(refs[0]).toMatch(/^rule:rule-6:reengage:c1:\d+$/);
      expect(new Set(refs).size).toBe(2);
      for (const call of scheduler.schedule.mock.calls) {
        expect(call[0]).toBe(TENANT);
        expect(call[1]).toMatchObject({
          templateId: 'nt-1',
          recipientType: 'CUSTOMER',
        });
        expect(call[4]).toBe('rule-6'); // rule id
      }
    });

    it('a re-run in the same period produces the SAME key, so the unique index absorbs it', async () => {
      db({ pages: [[{ id: 'c1' }]] });
      await service.sweep(AT_10_RIYADH);
      db({ pages: [[{ id: 'c1' }]] });
      await service.sweep(new Date(AT_10_RIYADH.getTime() + 60_000));
      const [a, b] = scheduler.schedule.mock.calls.map((c) => c[2]);
      expect(a).toBe(b);
    });

    it('a new cooldown period gives a new key (the patient can be invited again)', async () => {
      db({ pages: [[{ id: 'c1' }]] });
      await service.sweep(AT_10_RIYADH);
      const later = new Date(AT_10_RIYADH.getTime() + 91 * 86_400_000);
      db({ pages: [[{ id: 'c1' }]] });
      await service.sweep(later);
      const [a, b] = scheduler.schedule.mock.calls.map((c) => c[2]);
      expect(a).not.toBe(b);
    });

    it('stops at the daily cap, counting what earlier runs already scheduled today', async () => {
      db({
        rules: [
          dueRule({
            conditions: { inactivityDays: 180, cooldownDays: 90, dailyCap: 3 },
          }),
        ],
        today: 2,
        pages: [[{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]],
      });
      const out = await service.sweep(AT_10_RIYADH);
      expect(out.scheduled).toBe(1);
      const call = dataSource.query.mock.calls.find((c) =>
        (c[0] as string).includes('FROM customers c'),
      )!;
      expect(call[1][5]).toBe(1); // LIMIT = remaining
    });

    it('does nothing when the cap is already reached', async () => {
      db({ today: 100, pages: [[{ id: 'c1' }]] });
      expect((await service.sweep(AT_10_RIYADH)).scheduled).toBe(0);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('records the run on the rule', async () => {
      db({ pages: [[{ id: 'c1' }]] });
      await service.sweep(AT_10_RIYADH);
      expect(library.recordRun).toHaveBeenCalledWith('rule-6');
    });
  });

  describe('failure isolation', () => {
    it("one clinic's failure is recorded on its rule and does not stop the next", async () => {
      db({
        rules: [
          dueRule({ id: 'a', tenantId: 'ta' }),
          dueRule({ id: 'b', tenantId: 'tb' }),
        ],
        pages: [],
      });
      let first = true;
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM notification_rules'))
          return Promise.resolve([
            dueRule({ id: 'a', tenantId: 'ta' }),
            dueRule({ id: 'b', tenantId: 'tb' }),
          ]);
        if (sql.includes('COUNT(*)')) return Promise.resolve([{ n: 0 }]);
        if (first) {
          first = false;
          return Promise.reject(new Error('db hiccup'));
        }
        return Promise.resolve([{ id: 'c1' }]);
      });

      const out = await service.sweep(AT_10_RIYADH);

      expect(library.recordRun).toHaveBeenCalledWith('a', 'db hiccup');
      expect(out.scheduled).toBe(1);
    });

    it('stops when the lock is lost', async () => {
      db({ rules: [dueRule(), dueRule({ id: 'b' })], pages: [[{ id: 'c1' }]] });
      const out = await service.sweep(AT_10_RIYADH, {
        keepAlive: jest.fn().mockResolvedValue(false),
      });
      expect(out.processed).toBe(0);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });
  });

  describe('medical follow-up when due (rule 4)', () => {
    const followRule = (over: Record<string, unknown> = {}) =>
      dueRule({
        id: 'rule-4',
        rule_key: 'followup_due',
        conditions: null,
        ...over,
      });

    const dbFollow = (
      pages: Array<Array<{ id: string; customerId: string; due: string }>>,
      rules: unknown[] = [followRule()],
    ) => {
      const queue = [...pages];
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM notification_rules'))
          return Promise.resolve(rules);
        if (sql.includes('FROM appointments a'))
          return Promise.resolve(queue.shift() ?? []);
        return Promise.resolve([]);
      });
    };

    const candidate = () =>
      dataSource.query.mock.calls.find((c) =>
        (c[0] as string).includes('FROM appointments a'),
      )!;

    it('schedules one row per due appointment, to the patient, linked to the visit and the rule', async () => {
      dbFollow([[{ id: 'a1', customerId: 'c1', due: '2026-10-24' }]]);
      const out = await service.sweep(AT_10_RIYADH);

      expect(out).toMatchObject({ processed: 1, scheduled: 1 });
      const [tenant, dto, ref, , ruleId] = scheduler.schedule.mock.calls[0];
      expect(tenant).toBe(TENANT);
      expect(dto).toMatchObject({
        templateId: 'nt-1',
        recipientType: 'CUSTOMER',
        recipientId: 'c1',
        appointmentId: 'a1',
      });
      expect(ref).toBe(`rule:rule-4:followup:a1:${Date.UTC(2026, 9, 24)}`);
      expect(ruleId).toBe('rule-4');
      expect(library.recordRun).toHaveBeenCalledWith('rule-4');
    });

    it('acts at the clinic-local hour only', async () => {
      dbFollow([[{ id: 'a1', customerId: 'c1', due: '2026-10-24' }]]);
      expect((await service.sweep(AT_15_RIYADH)).processed).toBe(0);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it("compares the date with the CLINIC's today, not the server's", async () => {
      // 22:30Z = 01:30 on 1 Nov in Riyadh, but the sweep only acts at 10:00 local;
      // use 07:00Z on 31 Oct (10:00 local) and read the bound date parameter.
      dbFollow([[]]);
      await service.sweep(new Date('2026-10-31T07:00:00Z'));
      const [, params] = candidate();
      expect(params[1]).toBe('2026-10-31');
    });

    it('selects only what is due, consenting, reachable and not yet back', async () => {
      dbFollow([[]]);
      await service.sweep(AT_10_RIYADH);
      const [sql, params] = candidate();
      expect(sql).toContain("a.status = 'COMPLETED'");
      expect(sql).toContain('a.follow_up_due_on <= $2::date');
      expect(sql).toContain('a.follow_up_due_on > $2::date - $3::int'); // catch-up grace
      expect(sql).toContain('c.marketing_opt_in = true');
      expect(sql).toContain('c.opted_out_at IS NULL');
      expect(sql).toContain('c.is_active = true');
      expect(sql).toMatch(/BTRIM\(c\.phone\)/);
      // an upcoming appointment, or a later completed visit, means they came back
      expect(sql).toContain(
        "b.status IN ('CONFIRMED','PENDING_PAYMENT','IN_PROGRESS') AND b.start_at > now()",
      );
      expect(sql).toContain(
        "b.status = 'COMPLETED' AND b.start_at > a.start_at",
      );
      // already scheduled for this exact date → not selected again
      expect(sql).toContain('n.notification_rule_id = $4');
      expect(params[0]).toBe(TENANT);
      expect(params[2]).toBe(7);
      expect(params[3]).toBe('rule-4');
    });

    it('every join is tenant-scoped', async () => {
      dbFollow([[]]);
      await service.sweep(AT_10_RIYADH);
      const [sql] = candidate();
      expect(sql).toContain('a."tenantId" = $1');
      expect(sql).toContain('c."tenantId" = a."tenantId"');
      expect(sql).toContain('b."tenantId" = $1');
      expect(sql).toContain('n."tenantId" = $1');
    });

    it('a moved date is a different message; the same date is the same key', async () => {
      dbFollow([[{ id: 'a1', customerId: 'c1', due: '2026-10-24' }]]);
      await service.sweep(AT_10_RIYADH);
      dbFollow([[{ id: 'a1', customerId: 'c1', due: '2026-10-24' }]]);
      await service.sweep(new Date(AT_10_RIYADH.getTime() + 60_000));
      dbFollow([[{ id: 'a1', customerId: 'c1', due: '2026-10-25' }]]);
      await service.sweep(AT_10_RIYADH);
      const [a, b, c] = scheduler.schedule.mock.calls.map((x) => x[2]);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });

    it('pages through a large backlog without repeating a row', async () => {
      const page = (from: number, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          id: `a${from + i}`,
          customerId: `c${from + i}`,
          due: '2026-10-24',
        }));
      dbFollow([page(0, 200), page(200, 3)]);
      const out = await service.sweep(AT_10_RIYADH);
      expect(out.scheduled).toBe(203);
      const cursors = dataSource.query.mock.calls
        .filter((c) => (c[0] as string).includes('FROM appointments a'))
        .map((c) => c[1][4]);
      expect(cursors[0]).toBe('00000000-0000-0000-0000-000000000000');
      expect(cursors[1]).toBe('a199');
    });

    it('skips a follow-up rule with no template, and one failing clinic does not stop the next', async () => {
      dbFollow(
        [[{ id: 'a1', customerId: 'c1', due: '2026-10-24' }]],
        [followRule({ templateId: null })],
      );
      expect((await service.sweep(AT_10_RIYADH)).scheduled).toBe(0);

      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM notification_rules'))
          return Promise.resolve([
            followRule({ id: 'x', tenantId: 'tx' }),
            followRule({ id: 'y', tenantId: 'ty' }),
          ]);
        if (sql.includes('FROM appointments a')) {
          return dataSource.query.mock.calls.filter((c) =>
            (c[0] as string).includes('FROM appointments a'),
          ).length === 1
            ? Promise.reject(new Error('db hiccup'))
            : Promise.resolve([
                { id: 'a1', customerId: 'c1', due: '2026-10-24' },
              ]);
        }
        return Promise.resolve([]);
      });
      scheduler.schedule.mockClear();
      const out = await service.sweep(AT_10_RIYADH);
      expect(library.recordRun).toHaveBeenCalledWith('x', 'db hiccup');
      expect(out.scheduled).toBe(1);
    });

    it('runs the re-engagement and follow-up rules of one tick independently', async () => {
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM notification_rules'))
          return Promise.resolve([dueRule(), followRule()]);
        if (sql.includes('COUNT(*)')) return Promise.resolve([{ n: 0 }]);
        if (sql.includes('FROM customers c'))
          return Promise.resolve([{ id: 'c9' }]);
        if (sql.includes('FROM appointments a'))
          return Promise.resolve([
            { id: 'a1', customerId: 'c1', due: '2026-10-24' },
          ]);
        return Promise.resolve([]);
      });
      const out = await service.sweep(AT_10_RIYADH);
      expect(out).toMatchObject({ tenants: 2, processed: 2, scheduled: 2 });
      const refs = scheduler.schedule.mock.calls.map((c) => c[2] as string);
      expect(refs.some((r) => r.includes(':reengage:'))).toBe(true);
      expect(refs.some((r) => r.includes(':followup:'))).toBe(true);
    });
  });
});

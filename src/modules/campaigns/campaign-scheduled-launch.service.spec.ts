import { CampaignScheduledLaunchService } from './campaign-scheduled-launch.service';

const NOW = new Date('2026-10-24T09:00:00Z');

describe('CampaignScheduledLaunchService', () => {
  let dataSource: { query: jest.Mock };
  let execution: { launch: jest.Mock };
  let ctx: { run: jest.Mock; setPrincipal: jest.Mock };
  let service: CampaignScheduledLaunchService;

  const due = (n = 1) =>
    Array.from({ length: n }, (_, i) => ({
      id: `camp-${i}`,
      tenantId: `t${i}`,
      ruleId: `rule-${i}`,
    }));

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    execution = { launch: jest.fn().mockResolvedValue({}) };
    ctx = {
      run: jest.fn((fn: () => unknown) => fn()),
      setPrincipal: jest.fn(),
    };
    service = new CampaignScheduledLaunchService(
      dataSource as never,
      execution as never,
      ctx as never,
    );
  });

  const rows = (r: unknown[]) =>
    dataSource.query.mockImplementation((sql: string) =>
      sql.includes('FROM campaigns') ? Promise.resolve(r) : Promise.resolve([]),
    );

  it('only considers SCHEDULED campaigns of clinics that enabled the promotion rule, within 24h overdue', async () => {
    rows([]);
    await service.sweep(NOW);
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain("c.lifecycle = 'SCHEDULED'");
    expect(sql).toContain(
      "r.rule_key = 'scheduled_promotion' AND r.is_active = true",
    );
    expect(sql).toContain('c.deleted_at IS NULL');
    expect(sql).toContain('t.is_active = true');
    expect(params[0]).toEqual(NOW); // due now
    expect(params[1]).toEqual(new Date(NOW.getTime() - 24 * 3_600_000)); // not older than a day
  });

  it('launches through the same service a person’s click uses, as that campaign’s tenant', async () => {
    rows(due(2));
    const out = await service.sweep(NOW);

    expect(out).toEqual({ due: 2, launched: 2, failed: 0 });
    expect(execution.launch).toHaveBeenNthCalledWith(1, 't0', 'camp-0', {});
    expect(execution.launch).toHaveBeenNthCalledWith(2, 't1', 'camp-1', {});
    // The tenant context is restored per campaign, and never carries a user's identity.
    expect(ctx.setPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'system',
        tenantId: 't0',
        permissions: [],
      }),
    );
  });

  it('a launch that the preflight refuses is reported, left SCHEDULED, and does not stop the rest', async () => {
    rows(due(2));
    execution.launch.mockRejectedValueOnce(new Error('No approved template'));

    const out = await service.sweep(NOW);

    expect(out).toEqual({ due: 2, launched: 1, failed: 1 });
    const update = dataSource.query.mock.calls.find((c) =>
      (c[0] as string).includes('UPDATE notification_rules'),
    );
    expect(update![1]).toEqual(['rule-0', 'No approved template']);
  });

  it('records a clean run on the rule after a launch', async () => {
    rows(due(1));
    await service.sweep(NOW);
    const update = dataSource.query.mock.calls.find((c) =>
      (c[0] as string).includes('UPDATE notification_rules'),
    );
    expect(update![1]).toEqual(['rule-0', null]);
  });

  it('stops when the lock is lost', async () => {
    rows(due(3));
    const out = await service.sweep(NOW, {
      keepAlive: jest.fn().mockResolvedValue(false),
    });
    expect(out.launched).toBe(0);
    expect(execution.launch).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is due', async () => {
    rows([]);
    expect(await service.sweep(NOW)).toEqual({
      due: 0,
      launched: 0,
      failed: 0,
    });
    expect(execution.launch).not.toHaveBeenCalled();
  });

  it('a failure to record the run never fails the launch', async () => {
    dataSource.query.mockImplementation((sql: string) =>
      sql.includes('FROM campaigns')
        ? Promise.resolve(due(1))
        : Promise.reject(new Error('db')),
    );
    await expect(service.sweep(NOW)).resolves.toMatchObject({ launched: 1 });
  });
});

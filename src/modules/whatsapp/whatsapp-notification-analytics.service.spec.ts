import { WhatsappNotificationAnalyticsService } from './whatsapp-notification-analytics.service';

const NOW = new Date('2026-10-11T12:00:00.000Z');

function build(rows: Array<Array<Record<string, unknown>>>) {
  const query = jest.fn();
  rows.forEach((r) => query.mockResolvedValueOnce(r));
  // Any further query (should be none) resolves empty rather than hanging.
  query.mockResolvedValue([]);
  const service = new WhatsappNotificationAnalyticsService({ query } as never);
  return { service, query };
}

describe('WhatsappNotificationAnalyticsService.summary', () => {
  const periodRows = [
    {
      period: 'current',
      total: '120',
      pending: '10',
      cancelled: '10',
      sent: '80',
      failed: '15',
      uncertain: '5',
      whatsappSent: '70',
      emailFallback: '10',
      delivered: '56',
      read: '28',
      carrierFailed: '2',
      awaitingConfirmation: '12',
      matureWhatsappSent: '60',
      matureUnconfirmed: '8',
    },
    {
      period: 'previous',
      total: '50',
      sent: '40',
      failed: '5',
      uncertain: '0',
      whatsappSent: '40',
      delivered: '30',
      read: '10',
    },
  ];

  it('binds EVERY query to the tenant id as the first parameter', async () => {
    const { service, query } = build([periodRows, [], [], []]);
    await service.summary('tenant-A', '30d', 'Asia/Riyadh', NOW);

    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql, params] of query.mock.calls) {
      expect(params[0]).toBe('tenant-A');
      expect(sql).toContain('n."tenantId" = $1');
    }
  });

  it('restricts every query to WhatsApp-channel templates', async () => {
    const { service, query } = build([[], [], [], []]);
    await service.summary('tenant-A', '7d', null, NOW);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain("t.channel = 'WHATSAPP'");
    }
  });

  it('computes rates, denominators and the comparison from the aggregate rows', async () => {
    const { service } = build([periodRows, [], [], []]);
    const out = await service.summary('tenant-A', '30d', 'UTC', NOW);

    expect(out.current.counts.total).toBe(120);
    expect(out.current.denominators).toEqual({
      resolved: 100,
      whatsappSent: 70,
      delivered: 56,
    });
    expect(out.current.rates).toEqual({
      successRate: 80,
      failureRate: 15,
      deliveryRate: 80,
      readRate: 50,
    });
    expect(out.hasBaseline).toBe(true);
    expect(out.comparison.total).toMatchObject({
      absolute: 70,
      percent: 140,
      state: 'changed',
    });
    expect(out.comparison.deliveryRate.points).toBe(5); // 80 vs 75
  });

  it('returns null rates and zero counts — not NaN — for a clinic with no data', async () => {
    const { service } = build([[], [], [], []]);
    const out = await service.summary('tenant-A', '30d', 'UTC', NOW);

    expect(out.current.counts.total).toBe(0);
    expect(out.current.rates).toEqual({
      successRate: null,
      failureRate: null,
      deliveryRate: null,
      readRate: null,
    });
    expect(out.hasBaseline).toBe(false);
    expect(out.comparison.total).toMatchObject({
      percent: null,
      state: 'none',
    });
    expect(JSON.stringify(out)).not.toMatch(/NaN|Infinity/);
  });

  it('exposes failure categories only, never raw failure text', async () => {
    const { service } = build([
      [],
      [],
      [],
      [
        { code: 'OPTED_OUT', count: '4' },
        { code: 'recipient +966500000000 rejected', count: '1' },
      ],
    ]);
    const out = await service.summary('tenant-A', '30d', 'UTC', NOW);

    expect(out.failureReasons.map((r) => r.code)).toEqual([
      'OPTED_OUT',
      'OTHER',
    ]);
    expect(JSON.stringify(out)).not.toContain('966500000000');
  });

  it('truncates the template breakdown and says so', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      templateId: `tpl-${i}`,
      name: `Template ${i}`,
      total: String(20 - i),
      sent: '1',
    }));
    const { service } = build([[], [], many, []]);
    const out = await service.summary('tenant-A', '30d', 'UTC', NOW);

    expect(out.byTemplate).toHaveLength(10);
    expect(out.byTemplateTruncated).toBe(true);
  });

  it('falls back to UTC for a timezone Postgres would reject', async () => {
    const { service, query } = build([[], [], [], []]);
    const out = await service.summary('tenant-A', '30d', 'Mars/Olympus', NOW);

    expect(out.timezone).toBe('UTC');
    const trendCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('generate_series'),
    );
    expect(trendCall?.[1][3]).toBe('UTC');
  });
});

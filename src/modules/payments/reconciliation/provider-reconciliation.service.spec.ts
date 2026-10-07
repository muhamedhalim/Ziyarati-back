import { ProviderReconciliationService } from './provider-reconciliation.service';
import { ErrorCode } from '../../../common/errors';
import { PROVIDER_RECONCILIATION } from '../payments.constants';

/**
 * The checks and the writes are proven on real Postgres in
 * `test/provider-reconciliation.tap.e2e-spec.ts`; the pure comparisons in
 * `reconciliation-math.spec.ts` and the parser in `tap-report.parser.spec.ts`.
 * This file pins the seams around them: when the sweep exists at all, and what the
 * manual import refuses before it touches anything.
 */
describe('ProviderReconciliationService', () => {
  let client: {
    isConfigured: boolean;
    downloadCharges: jest.Mock;
    listPayouts: jest.Mock;
  };
  let config: { providerName: string; tapMerchantId?: string };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let exceptions: { raise: jest.Mock; autoResolve: jest.Mock };
  let audit: { record: jest.Mock };

  const build = () =>
    new ProviderReconciliationService(
      {
        // markReports(): UPDATE merchant_accounts … — a chainable query builder
        createQueryBuilder: jest.fn(() => {
          const qb: any = {};
          for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
          qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
          return qb;
        }),
      } as any,
      dataSource as any,
      client as any,
      config as any,
      exceptions as any,
      { mapPayments: jest.fn() } as any,
      audit as any,
    );

  beforeEach(() => {
    client = {
      isConfigured: true,
      downloadCharges: jest.fn(),
      listPayouts: jest.fn(),
    };
    config = { providerName: 'tap', tapMerchantId: 'merchant_PLATFORM' };
    dataSource = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(),
    };
    exceptions = {
      raise: jest.fn().mockResolvedValue({ created: false, reopened: false }),
      autoResolve: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  describe('enabled', () => {
    it.each([
      ['tap with a key', 'tap', true, true],
      ['tap without a key', 'tap', false, false],
      ['noop', 'noop', true, false],
    ])('%s → %s', (_l, provider, configured, expected) => {
      config.providerName = provider;
      client.isConfigured = configured;
      expect(build().enabled).toBe(expected);
    });
  });

  describe('run', () => {
    it('does nothing — asks Tap nothing, reads nothing — while Tap is not the active provider', async () => {
      config.providerName = 'noop';
      const res = await build().run({ lookbackDays: 3 });
      expect(res).toEqual({
        skipped: 'tap_not_active',
        merchants: [],
        exceptions: 0,
      });
      expect(client.downloadCharges).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it("clamps the look-back to Tap's 30-day reporting window, and to at least a day", async () => {
      client.downloadCharges.mockResolvedValue({
        ok: false,
        status: 403,
        json: {},
        transient: false,
      });
      const now = new Date('2026-10-05T12:00:00Z');

      await build().run({ lookbackDays: 365, now });
      const wide = client.downloadCharges.mock.calls[0][0].period.date;
      expect(Number(wide.to) - Number(wide.from)).toBe(
        PROVIDER_RECONCILIATION.MAX_WINDOW_DAYS * 86_400_000,
      );

      client.downloadCharges.mockClear();
      await build().run({ lookbackDays: 0, now });
      const narrow = client.downloadCharges.mock.calls[0][0].period.date;
      expect(Number(narrow.to) - Number(narrow.from)).toBe(86_400_000);
    });

    it("reconciles ZiyaraTech's own merchant first, then each clinic merchant once (never the platform twice)", async () => {
      dataSource.query.mockResolvedValueOnce([
        { merchant_id: 'merchant_PLATFORM', tenant_id: 'tp' }, // a clinic row carrying the platform id: skipped
        { merchant_id: 'merchant_A', tenant_id: 't-a' },
        { merchant_id: 'merchant_B', tenant_id: 't-b' },
      ]);
      client.downloadCharges.mockResolvedValue({
        ok: false,
        status: 403,
        json: {},
        transient: false,
      });

      const res = await build().run({ lookbackDays: 3 });

      expect(res.merchants.map((m) => [m.scope, m.merchantId])).toEqual([
        ['platform', 'merchant_PLATFORM'],
        ['clinic', 'merchant_A'],
        ['clinic', 'merchant_B'],
      ]);
    });

    it('one merchant throwing does not stop the others', async () => {
      dataSource.query.mockResolvedValueOnce([
        { merchant_id: 'merchant_A', tenant_id: 't-a' },
        { merchant_id: 'merchant_B', tenant_id: 't-b' },
      ]);
      client.downloadCharges
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({
          ok: false,
          status: 403,
          json: {},
          transient: false,
        });

      const res = await build().run({ lookbackDays: 3 });

      expect(res.merchants).toHaveLength(3);
      expect(res.merchants[0]).toMatchObject({
        merchantId: 'merchant_PLATFORM',
        error: 'boom',
      });
      expect(res.merchants[2]).toMatchObject({
        merchantId: 'merchant_B',
        reports: 'unreachable',
      });
    });

    it('a Tap outage on a report is "unavailable": no exception, no verdict', async () => {
      client.downloadCharges.mockResolvedValue({
        ok: false,
        status: 503,
        json: {},
        transient: true,
      });
      const res = await build().run({ lookbackDays: 3 });
      expect(res.merchants[0].reports).toBe('unavailable');
      expect(exceptions.raise).not.toHaveBeenCalled();
    });
  });

  describe('importChargesReport — refused before anything is touched', () => {
    it.each([
      ['empty', ''],
      ['blank', '  \n '],
    ])('%s', async (_l, csv) => {
      await expect(build().importChargesReport(csv, 'a')).rejects.toMatchObject(
        {
          code: ErrorCode.UNPROCESSABLE_ENTITY,
        },
      );
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('not a string', async () => {
      await expect(
        build().importChargesReport(undefined as any, 'a'),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('too large', async () => {
      await expect(
        build().importChargesReport(
          'x'.repeat(PROVIDER_RECONCILIATION.MAX_IMPORT_CHARS + 1),
          'a',
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        message: expect.stringContaining('too large'),
      });
    });

    it.each([
      ['an HTML error page', '<html><body>502</body></html>'],
      ['a CSV missing the required columns', 'charge_id,amount\nchg_1,10'],
    ])('%s', async (_l, csv) => {
      await expect(build().importChargesReport(csv, 'a')).rejects.toMatchObject(
        {
          code: ErrorCode.UNPROCESSABLE_ENTITY,
          message: 'This is not a Tap charges report',
        },
      );
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('a valid but EMPTY report imports nothing, and is still audited', async () => {
      const res = await build().importChargesReport(
        'charge_id,currency,amount,status\n',
        'admin-1',
      );
      expect(res).toMatchObject({
        scope: 'import',
        rows: 0,
        matched: 0,
        feesApplied: 0,
        exceptions: 0,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.reconciliation.report_imported',
          userId: 'admin-1',
          after: expect.objectContaining({ rows: 0 }),
        }),
      );
    });
  });
});

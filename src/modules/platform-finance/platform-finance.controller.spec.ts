import { PlatformFinanceController } from './platform-finance.controller';
import { FINANCIAL_AUDIT_ACTION } from './financial-audit.service';
import { ROLE } from '../../rbac/rbac.constants';
import { classRoles, guardNames } from '../../../test/utils/route-metadata';

const USER = 'user-1';
const IP = '203.0.113.9';
const ID = '44444444-4444-4444-8444-444444444444';

describe('PlatformFinanceController', () => {
  const finance = {
    kpis: jest.fn(),
    listTransactions: jest.fn(),
    exportCsv: jest.fn(),
    getTransaction: jest.fn(),
    metricDrilldown: jest.fn(),
    clinicSummary: jest.fn(),
  };
  const subscriptions = { list: jest.fn(), exportCsv: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const controller = new PlatformFinanceController(finance as never, subscriptions as never, audit as never);

  beforeEach(() => {
    jest.clearAllMocks();
    audit.record.mockResolvedValue(undefined);
  });

  it('is super-admin only, enforced by RolesGuard on the whole controller', () => {
    expect(classRoles(PlatformFinanceController)).toEqual([ROLE.SUPER_ADMIN]);
    expect(guardNames(PlatformFinanceController)).toContain('RolesGuard');
  });

  describe('read-only listings delegate without writing the audit trail', () => {
    it('kpis, transactions, subscription invoices and the clinic summary', async () => {
      finance.kpis.mockResolvedValue({ gross: 1 });
      await expect(controller.kpis()).resolves.toEqual({ gross: 1 });

      await controller.list({ page: 2 } as never);
      expect(finance.listTransactions).toHaveBeenCalledWith({ page: 2 });

      await controller.subscriptionInvoices({ page: 3 } as never);
      expect(subscriptions.list).toHaveBeenCalledWith({ page: 3 });

      await controller.clinicSummary(ID);
      expect(finance.clinicSummary).toHaveBeenCalledWith(ID);

      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('every export and every single-record view is written to the financial audit trail', () => {
    it('marketplace export audits the filters it was run with and the size of the file', async () => {
      finance.exportCsv.mockResolvedValue({ content: 'id,amount\n1,10\n2,20\n', filename: 'f.csv' });
      const result = await controller.export({ status: 'PAID' } as never, USER, IP);

      expect(result.filename).toBe('f.csv');
      expect(audit.record).toHaveBeenCalledWith(
        FINANCIAL_AUDIT_ACTION.EXPORT,
        USER,
        IP,
        undefined,
        { filters: { status: 'PAID' }, rows: expect.any(Number) },
      );
    });

    it('subscription-invoice export is audited too, with its own scope', async () => {
      subscriptions.exportCsv.mockResolvedValue({ content: 'h\n', filename: 's.csv' });
      await controller.exportSubscriptionInvoices({ currency: 'SAR' } as never, USER, IP);

      expect(audit.record).toHaveBeenCalledWith(
        FINANCIAL_AUDIT_ACTION.EXPORT,
        USER,
        IP,
        undefined,
        { scope: 'subscription-invoices', filters: { currency: 'SAR' }, rows: expect.any(Number) },
      );
    });

    it('a transaction detail view records WHICH transaction was read', async () => {
      finance.getTransaction.mockResolvedValue({ id: ID });
      await expect(controller.detail(ID, USER, IP)).resolves.toEqual({ id: ID });
      expect(audit.record).toHaveBeenCalledWith(FINANCIAL_AUDIT_ACTION.VIEW, USER, IP, ID);
    });

    it('a metric drill-down records the metric that was opened', async () => {
      finance.metricDrilldown.mockResolvedValue({ ok: true });
      await controller.metricDrilldown('gross', { page: 1 } as never, USER, IP);

      expect(finance.metricDrilldown).toHaveBeenCalledWith('gross', { page: 1 });
      expect(audit.record).toHaveBeenCalledWith(FINANCIAL_AUDIT_ACTION.VIEW, USER, IP, undefined, {
        metric: 'gross',
      });
    });

    it('an export whose data call fails is NOT recorded as having happened', async () => {
      finance.exportCsv.mockRejectedValue(new Error('db down'));
      await expect(controller.export({} as never, USER, IP)).rejects.toThrow('db down');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('if the audit write fails the data is not returned (no unaudited read of financial records)', async () => {
      finance.getTransaction.mockResolvedValue({ id: ID });
      audit.record.mockRejectedValue(new Error('audit unavailable'));
      await expect(controller.detail(ID, USER, IP)).rejects.toThrow('audit unavailable');
    });
  });
});

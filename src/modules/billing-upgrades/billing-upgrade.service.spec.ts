import { BillingUpgradeService } from './billing-upgrade.service';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { ErrorCode } from '../../common/errors';
import { BILLING_UPGRADE_STATUS, BILLING_UPGRADE_TYPE } from './billing-upgrade.constants';
import {
  createMockDataSource,
  createMockEntityManager,
  createMockRepository,
  createMockQueryBuilder,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('BillingUpgradeService', () => {
  let service: BillingUpgradeService;
  let requests: MockRepository;
  let featureDefinitions: MockRepository;
  let dataSource: MockDataSource;
  let usage: { getBreakdown: jest.Mock };
  let featureFlags: { isEnabled: jest.Mock };
  let payments: { create: jest.Mock };
  let history: { record: jest.Mock; listVisible: jest.Mock };
  const repoMap = new Map();

  beforeEach(() => {
    requests = createMockRepository();
    // T047 (015-db-api-efficiency-audit, P7-2/ORM-001): list() now reads the
    // tenant FK column via entity metadata (R-11 — BillingUpgradeRequest
    // exposes no plain `tenantId` property), the same
    // `.metadata.findRelationWithPropertyPath` pattern used elsewhere in this
    // audit. `tenantId` matches the real column name (migration
    // 1730012000000-BillingUpgradeRequests: `billing_upgrade_requests."tenantId"`).
    (requests as unknown as { metadata: unknown }).metadata = {
      name: 'BillingUpgradeRequest',
      findRelationWithPropertyPath: (path: string) =>
        path === 'tenant' ? { joinColumns: [{ databaseName: 'tenantId' }] } : undefined,
    };
    featureDefinitions = createMockRepository();
    repoMap.set(BillingUpgradeRequest, requests);
    dataSource = createMockDataSource(createMockEntityManager(repoMap));
    usage = { getBreakdown: jest.fn() };
    featureFlags = { isEnabled: jest.fn().mockResolvedValue(false) };
    payments = { create: jest.fn() };
    history = { record: jest.fn(), listVisible: jest.fn().mockResolvedValue([]) };

    service = new BillingUpgradeService(
      requests as any,
      featureDefinitions as any,
      dataSource as any,
      usage as any,
      featureFlags as any,
      payments as any,
      history as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  const actor = { id: 'user-1', email: 'owner@clinic.test' };

  describe('create — feature requests', () => {
    it('rejects an unknown feature key', async () => {
      featureDefinitions.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create('t1', actor, { type: BILLING_UPGRADE_TYPE.FEATURE, featureKey: 'not-real' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_UPGRADE_METRIC });
    });

    it('rejects a feature already enabled for the tenant', async () => {
      featureDefinitions.findOne.mockResolvedValueOnce({ feature_key: 'ai_agent', is_active: true });
      featureFlags.isEnabled.mockResolvedValueOnce(true);
      await expect(
        service.create('t1', actor, { type: BILLING_UPGRADE_TYPE.FEATURE, featureKey: 'ai_agent' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('creates a pending_review request and records history', async () => {
      featureDefinitions.findOne.mockResolvedValueOnce({ feature_key: 'ai_agent', is_active: true });
      requests.findOne.mockResolvedValueOnce(null); // no active duplicate
      requests.save.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.PENDING_REVIEW });

      const result = await service.create('t1', actor, {
        type: BILLING_UPGRADE_TYPE.FEATURE,
        featureKey: 'ai_agent',
      } as any);

      expect(result.id).toBe('req-1');
      expect(history.record).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-1', toValue: BILLING_UPGRADE_STATUS.PENDING_REVIEW }),
      );
    });
  });

  describe('create — usage_limit requests', () => {
    it('rejects a metric that is already unlimited', async () => {
      usage.getBreakdown.mockResolvedValueOnce({ metrics: { aiTokens: { used: 10, limit: null } } });
      await expect(
        service.create('t1', actor, {
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usageMetric: 'AI_TOKENS',
          requestedQuantity: 999,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('rejects a requested quantity at or below the current limit', async () => {
      usage.getBreakdown.mockResolvedValueOnce({ metrics: { aiTokens: { used: 50, limit: 100 } } });
      await expect(
        service.create('t1', actor, {
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usageMetric: 'AI_TOKENS',
          requestedQuantity: 100,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('rejects a duplicate active request for the same metric', async () => {
      usage.getBreakdown.mockResolvedValueOnce({ metrics: { aiTokens: { used: 50, limit: 100 } } });
      requests.findOne.mockResolvedValueOnce({ id: 'existing-req' });
      await expect(
        service.create('t1', actor, {
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usageMetric: 'AI_TOKENS',
          requestedQuantity: 500,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.DUPLICATE_ACTIVE_REQUEST });
    });

    it('converts a unique-constraint race into DUPLICATE_ACTIVE_REQUEST', async () => {
      usage.getBreakdown.mockResolvedValueOnce({ metrics: { aiTokens: { used: 50, limit: 100 } } });
      requests.findOne.mockResolvedValueOnce(null);
      requests.save.mockRejectedValueOnce({ code: '23505' });
      await expect(
        service.create('t1', actor, {
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usageMetric: 'AI_TOKENS',
          requestedQuantity: 500,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.DUPLICATE_ACTIVE_REQUEST });
    });
  });

  describe('tenant isolation', () => {
    /** Wires `requests.createQueryBuilder()` to return `getManyAndCount()`
     *  resolving to `[rows, total]` for exactly the next call — list()'s
     *  real mechanism (T047), replacing the old `findAndCount` mock. */
    function mockList(rows: unknown[], total: number) {
      const qb = createMockQueryBuilder();
      (qb as unknown as { getManyAndCount: jest.Mock }).getManyAndCount = jest
        .fn()
        .mockResolvedValue([rows, total]);
      requests.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    }

    it('list() always filters by the caller tenant', async () => {
      const qb = mockList([], 0);
      await service.list('tenant-a', { page: 1, limit: 20 } as any);
      expect(qb.where).toHaveBeenCalledWith('r."tenantId" = :tenantId', {
        tenantId: 'tenant-a',
      });
    });

    // T047 — the mandatory per-site assertion set (identical result, empty
    // for non-match, empty for a foreign tenant already covered above,
    // statement count).
    it('list() returns an empty page when no requests match', async () => {
      mockList([], 0);
      const res = await service.list('tenant-a', { page: 1, limit: 20 } as any);
      expect(res).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });

    it('list() resolves matching rows identically to before, and applies an optional status filter', async () => {
      const qb = mockList([{ id: 'req-1' }], 1);
      const res = await service.list('tenant-a', {
        page: 1,
        limit: 20,
        status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
      } as any);
      expect(res).toEqual({ data: [{ id: 'req-1' }], total: 1, page: 1, limit: 20 });
      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', {
        status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
      });
    });

    it('list() issues exactly one query (createQueryBuilder, not findAndCount) with limit/offset, never skip/take', async () => {
      const qb = mockList([{ id: 'req-1' }], 1);
      await service.list('tenant-a', { page: 2, limit: 20 } as any);

      expect(requests.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(requests.findAndCount).not.toHaveBeenCalled();
      expect(qb.getManyAndCount).toHaveBeenCalledTimes(1);
      expect(qb.limit).toHaveBeenCalledWith(20);
      expect(qb.offset).toHaveBeenCalledWith(20); // (page 2 - 1) * limit 20
      expect(qb.skip).not.toHaveBeenCalled();
      expect(qb.take).not.toHaveBeenCalled();
    });

    it('get() 404s for a request belonging to another tenant', async () => {
      requests.findOne.mockResolvedValueOnce(null); // findOne scoped by {id, tenant} finds nothing
      await expect(service.get('tenant-a', 'req-of-tenant-b')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(requests.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'req-of-tenant-b', tenant: { id: 'tenant-a' } } }),
      );
    });
  });

  describe('cancel', () => {
    it('rejects cancelling a completed request', async () => {
      dataSource.manager.getRepository = jest.fn(() => requests) as any;
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.COMPLETED });
      await expect(service.cancel('t1', 'req-1', actor)).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST_STATUS,
      });
    });

    it('cancels a pending_review request', async () => {
      dataSource.manager.getRepository = jest.fn(() => requests) as any;
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.PENDING_REVIEW });
      requests.save.mockImplementationOnce(async (r: any) => r);
      const result = await service.cancel('t1', 'req-1', actor);
      expect(result.status).toBe(BILLING_UPGRADE_STATUS.CANCELLED);
    });
  });

  describe('accept', () => {
    beforeEach(() => {
      dataSource.manager.getRepository = jest.fn(() => requests) as any;
    });

    it('rejects accepting a request that has not been quoted yet', async () => {
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.PENDING_REVIEW });
      await expect(service.accept('t1', 'req-1', actor)).rejects.toMatchObject({
        code: ErrorCode.REQUEST_NOT_QUOTED,
      });
      expect(payments.create).not.toHaveBeenCalled();
    });

    it('expires an accept attempt past the quote deadline (and flips status atomically)', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL,
        final_price_minor: '15000',
        quote_expires_at: new Date(Date.now() - 60_000),
      });
      requests.save.mockImplementationOnce(async (r: any) => r);
      await expect(service.accept('t1', 'req-1', actor)).rejects.toMatchObject({
        code: ErrorCode.QUOTE_EXPIRED,
      });
      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: BILLING_UPGRADE_STATUS.EXPIRED }),
      );
      expect(payments.create).not.toHaveBeenCalled();
    });

    it('never trusts client-supplied price — charges exactly the stored final_price_minor', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL,
        final_price_minor: '15050', // 150.50 in major units
        currency: 'SAR',
        quote_expires_at: null,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: 'ai_agent',
      });
      requests.save.mockImplementationOnce(async (r: any) => r);
      payments.create.mockResolvedValueOnce({
        payment: { id: 'pay-1', gateway_payment_id: 'gw-1', status: 'PENDING' },
        redirectUrl: 'https://pay.example/checkout/1',
      });
      dataSource.query.mockResolvedValueOnce([[], 1]); // link succeeds
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', payment: { id: 'pay-1', status: 'PENDING' } });

      const result = await service.accept('t1', 'req-1', actor);

      expect(payments.create).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ amount: 150.5, currency: 'SAR' }),
        // Phase 1.5 (plan §12) — this charge is the clinic paying the
        // platform, not a patient payment: must bypass the merchant gate
        // and never carry a marketplace split.
        { platformRevenue: true },
      );
      expect(result.redirectUrl).toBe('https://pay.example/checkout/1');
    });

    it('repeated owner approval while already payment_processing resumes instead of re-charging', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        payment: { id: 'pay-1', status: 'PENDING', metadata: { redirect_url: 'https://pay.example/1' } },
      });

      const result = await service.accept('t1', 'req-1', actor);

      expect(payments.create).not.toHaveBeenCalled();
      expect(result.redirectUrl).toBe('https://pay.example/1');
    });

    it('rejects accepting a terminal (already completed) request', async () => {
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.COMPLETED });
      await expect(service.accept('t1', 'req-1', actor)).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST_STATUS,
      });
    });
  });
});

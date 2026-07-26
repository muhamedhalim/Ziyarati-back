import { BillingUpgradeAdminService } from './billing-upgrade-admin.service';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { ErrorCode } from '../../common/errors';
import { BILLING_UPGRADE_STATUS, BILLING_UPGRADE_TYPE } from './billing-upgrade.constants';
import {
  createMockDataSource,
  createMockEntityManager,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('BillingUpgradeAdminService', () => {
  let service: BillingUpgradeAdminService;
  let requests: MockRepository;
  let dataSource: MockDataSource;
  let usage: { getHistoricalAverage: jest.Mock };
  let aiEstimate: { estimate: jest.Mock };
  let history: { record: jest.Mock; listAll: jest.Mock };
  const repoMap = new Map();
  const actor = { id: 'admin-1', email: 'admin@platform.test' };

  beforeEach(() => {
    requests = createMockRepository();
    repoMap.set(BillingUpgradeRequest, requests);
    dataSource = createMockDataSource(createMockEntityManager(repoMap));
    usage = { getHistoricalAverage: jest.fn().mockResolvedValue(null) };
    aiEstimate = { estimate: jest.fn() };
    history = { record: jest.fn(), listAll: jest.fn().mockResolvedValue([]) };

    service = new BillingUpgradeAdminService(
      requests as any,
      dataSource as any,
      usage as any,
      aiEstimate as any,
      history as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  const futureIso = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  describe('quote', () => {
    beforeEach(() => {
      dataSource.manager.getRepository = jest.fn(() => requests) as any;
    });

    it('rejects quoting a request that is not in a quotable status', async () => {
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING });
      await expect(
        service.quote('req-1', actor, {
          finalPriceMinor: 10000,
          billingPeriod: 'one_time',
          quoteExpiresAt: futureIso(),
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_REQUEST_STATUS });
    });

    it('rejects an approvedQuantity at or below the current limit (tamper/consistency guard)', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
        type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
        current_limit: '1000',
      });
      await expect(
        service.quote('req-1', actor, {
          approvedQuantity: 500,
          finalPriceMinor: 10000,
          billingPeriod: 'one_time',
          quoteExpiresAt: futureIso(),
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('rejects a quote expiry that is not in the future', async () => {
      await expect(
        service.quote('req-1', actor, {
          finalPriceMinor: 10000,
          billingPeriod: 'one_time',
          quoteExpiresAt: new Date(Date.now() - 1000).toISOString(),
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('quotes successfully even when no AI estimate was ever generated (never blocks manual pricing)', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        ai_estimated_provider_cost_minor: undefined,
        ai_recommended_price_minor: undefined,
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      const result = await service.quote('req-1', actor, {
        finalPriceMinor: 25000,
        billingPeriod: 'monthly',
        quoteExpiresAt: futureIso(),
        notes: 'Manual price — AI estimate unavailable',
      } as any);

      expect(result.status).toBe(BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL);
      expect(result.final_price_minor).toBe('25000');
    });
  });

  describe('reject', () => {
    it('rejects a request from pending_review', async () => {
      dataSource.manager.getRepository = jest.fn(() => requests) as any;
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.PENDING_REVIEW });
      requests.save.mockImplementationOnce(async (r: any) => r);
      const result = await service.reject('req-1', actor, { reason: 'Not a good fit right now' });
      expect(result.status).toBe(BILLING_UPGRADE_STATUS.REJECTED);
    });

    it('cannot reject an already-completed request', async () => {
      dataSource.manager.getRepository = jest.fn(() => requests) as any;
      requests.findOne.mockResolvedValueOnce({ id: 'req-1', status: BILLING_UPGRADE_STATUS.COMPLETED });
      await expect(service.reject('req-1', actor, { reason: 'too late' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_REQUEST_STATUS,
      });
    });
  });

  describe('generateEstimate', () => {
    it('stores a heuristic-fallback estimate without throwing when the AI provider fails', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: 'ai_agent',
        tenant: { id: 't1' },
        currency: 'SAR',
      });
      aiEstimate.estimate.mockResolvedValueOnce({
        estimatedProviderCostMinor: 0,
        estimatedInfraCostMinor: 0,
        recommendedPriceMinor: 0,
        confidenceScore: 0,
        assumptions: ['fallback'],
        pricingBreakdown: {},
        source: 'heuristic_fallback',
        error: 'AI provider failed',
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      const result = await service.generateEstimate('req-1', actor);

      expect(result.ai_estimate_error).toBe('AI provider failed');
      expect(history.record).toHaveBeenCalled();
    });
  });
});

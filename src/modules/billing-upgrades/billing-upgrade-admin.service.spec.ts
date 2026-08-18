import { BillingUpgradeAdminService } from './billing-upgrade-admin.service';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';
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
    let catalog: MockRepository;

    beforeEach(() => {
      catalog = createMockRepository();
      dataSource.manager.getRepository = jest.fn((entity: unknown) =>
        entity === ResourcePriceCatalog ? catalog : requests,
      ) as any;
    });

    /** An active, priced AI_TOKENS catalog row — 10.00 SAR (1000 minor units) per 1,000 tokens. */
    const aiTokensCatalogItem = (overrides: Partial<ResourcePriceCatalog> = {}) => ({
      item_key: 'AI_TOKENS',
      kind: 'credit',
      unit_label: 'tokens_1k',
      unit_size: '1000',
      unit_price_minor: '1000',
      currency: 'SAR',
      min_quantity: 1,
      max_quantity: 20,
      is_active: true,
      sort_order: 0,
      ...overrides,
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

    describe('catalog-priced usage_limit requests (10 SAR / 1,000 AI tokens)', () => {
      it.each([
        [1000, 1000], // 1,000 tokens  = 10.00 SAR
        [2000, 2000], // 2,000 tokens  = 20.00 SAR
        [5000, 5000], // 5,000 tokens  = 50.00 SAR
        [10000, 10000], // 10,000 tokens = 100.00 SAR
        [20000, 20000], // 20,000 tokens = 200.00 SAR
      ])(
        'recomputes finalPriceMinor for an approvedQuantity delta of %i tokens as %i minor units, ignoring the client-sent price',
        async (approvedQuantity, expectedPriceMinor) => {
          requests.findOne.mockResolvedValueOnce({
            id: 'req-1',
            status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
            type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
            usage_metric: 'AI_TOKENS',
            current_limit: '0',
          });
          catalog.findOne.mockResolvedValueOnce(aiTokensCatalogItem());
          requests.save.mockImplementationOnce(async (r: any) => r);

          const result = await service.quote('req-1', actor, {
            approvedQuantity,
            finalPriceMinor: 999_999_999, // deliberately wrong — must be ignored, never trusted
            billingPeriod: 'one_time',
            quoteExpiresAt: futureIso(),
          } as any);

          expect(result.final_price_minor).toBe(String(expectedPriceMinor));
        },
      );

      it('rejects a delta above the current limit that is not an exact multiple of the catalog unit size', async () => {
        requests.findOne.mockResolvedValueOnce({
          id: 'req-1',
          status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usage_metric: 'AI_TOKENS',
          current_limit: '0',
        });
        catalog.findOne.mockResolvedValueOnce(aiTokensCatalogItem());

        await expect(
          service.quote('req-1', actor, {
            approvedQuantity: 1500, // delta 1500 is not a multiple of unit_size 1000
            finalPriceMinor: 1500,
            billingPeriod: 'one_time',
            quoteExpiresAt: futureIso(),
          } as any),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      });

      it('rejects a quantity below the catalog minimum', async () => {
        requests.findOne.mockResolvedValueOnce({
          id: 'req-1',
          status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usage_metric: 'AI_TOKENS',
          current_limit: '0',
        });
        catalog.findOne.mockResolvedValueOnce(aiTokensCatalogItem({ min_quantity: 5 }));

        await expect(
          service.quote('req-1', actor, {
            approvedQuantity: 2000, // 2 lots, below the min of 5
            finalPriceMinor: 2000,
            billingPeriod: 'one_time',
            quoteExpiresAt: futureIso(),
          } as any),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      });

      it('rejects a quantity above the catalog maximum', async () => {
        requests.findOne.mockResolvedValueOnce({
          id: 'req-1',
          status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usage_metric: 'AI_TOKENS',
          current_limit: '0',
        });
        catalog.findOne.mockResolvedValueOnce(aiTokensCatalogItem({ max_quantity: 10 }));

        await expect(
          service.quote('req-1', actor, {
            approvedQuantity: 11000, // 11 lots, above the max of 10
            finalPriceMinor: 11000,
            billingPeriod: 'one_time',
            quoteExpiresAt: futureIso(),
          } as any),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      });

      it('falls back to the manually-typed price when the catalog item is inactive/unpriced', async () => {
        requests.findOne.mockResolvedValueOnce({
          id: 'req-1',
          status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usage_metric: 'AI_TOKENS',
          current_limit: '0',
        });
        catalog.findOne.mockResolvedValueOnce(aiTokensCatalogItem({ is_active: false }));
        requests.save.mockImplementationOnce(async (r: any) => r);

        const result = await service.quote('req-1', actor, {
          approvedQuantity: 1500, // would be an invalid multiple under catalog pricing — irrelevant here
          finalPriceMinor: 7777,
          billingPeriod: 'one_time',
          quoteExpiresAt: futureIso(),
        } as any);

        expect(result.final_price_minor).toBe('7777');
      });

      it('falls back to the manually-typed price when current_limit is unbounded (null)', async () => {
        requests.findOne.mockResolvedValueOnce({
          id: 'req-1',
          status: BILLING_UPGRADE_STATUS.PENDING_REVIEW,
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          usage_metric: 'AI_TOKENS',
          current_limit: undefined,
        });
        catalog.findOne.mockResolvedValueOnce(aiTokensCatalogItem());
        requests.save.mockImplementationOnce(async (r: any) => r);

        const result = await service.quote('req-1', actor, {
          approvedQuantity: 5000,
          finalPriceMinor: 12345,
          billingPeriod: 'one_time',
          quoteExpiresAt: futureIso(),
        } as any);

        expect(result.final_price_minor).toBe('12345');
      });
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

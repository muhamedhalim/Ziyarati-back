import { BillingUpgradeEntitlementListener } from './billing-upgrade-entitlement.listener';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import {
  PaymentFailedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';
import {
  BILLING_UPGRADE_STATUS,
  BILLING_UPGRADE_TYPE,
} from './billing-upgrade.constants';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { FeatureFlagSource } from '../../entities/SaaS-Core/FeatureFlag';
import {
  createMockDataSource,
  createMockEntityManager,
  createMockQueryBuilder,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('BillingUpgradeEntitlementListener', () => {
  let listener: BillingUpgradeEntitlementListener;
  let requests: MockRepository;
  let dataSource: MockDataSource;
  let featureFlags: { set: jest.Mock; invalidateCache: jest.Mock };
  let limitOverrides: { grantOrExtend: jest.Mock };
  let history: { record: jest.Mock };
  const repoMap = new Map();

  beforeEach(() => {
    requests = createMockRepository();
    repoMap.set(BillingUpgradeRequest, requests);
    dataSource = createMockDataSource(createMockEntityManager(repoMap));
    dataSource.manager.getRepository = jest.fn(() => requests) as any;
    featureFlags = {
      set: jest.fn().mockResolvedValue(undefined),
      invalidateCache: jest.fn(),
    };
    limitOverrides = { grantOrExtend: jest.fn().mockResolvedValue(undefined) };
    history = { record: jest.fn().mockResolvedValue(undefined) };

    listener = new BillingUpgradeEntitlementListener(
      dataSource as any,
      featureFlags as any,
      limitOverrides as any,
      history as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * The request the by-payment LOCK query finds. The listener locks the row with
   * a query builder on the raw "paymentId" column (no join — Postgres refuses
   * FOR UPDATE across the nullable side of an outer join) and then re-reads its
   * relations UNLOCKED, so both reads return the same row.
   */
  const foundByPayment = (row: unknown) => {
    const qb = createMockQueryBuilder();
    qb.getOne.mockResolvedValueOnce(row);
    requests.createQueryBuilder.mockReturnValueOnce(qb);
    requests.findOne.mockResolvedValueOnce(row);
    return qb;
  };

  describe('onPaymentSucceeded', () => {
    it('applies a feature grant and marks the request completed', async () => {
      foundByPayment({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: FeatureKey.AI_ASSISTANT,
        tenant: { id: 't1' },
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      await listener.onPaymentSucceeded(
        new PaymentSucceededEvent('t1', 'pay-1', 150.5, 'SAR', undefined),
      );

      // Stamped BILLING_UPGRADE, not PLATFORM_ADMIN: a paid grant is
      // authoritative, but the audit trail must still say it came from a
      // purchase rather than a super-admin decision.
      expect(featureFlags.set).toHaveBeenCalledWith(
        't1',
        FeatureKey.AI_ASSISTANT,
        true,
        expect.objectContaining({ source: FeatureFlagSource.BILLING_UPGRADE }),
      );
      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: BILLING_UPGRADE_STATUS.COMPLETED }),
      );
      expect(history.record).toHaveBeenCalledWith(
        expect.objectContaining({ toValue: BILLING_UPGRADE_STATUS.COMPLETED }),
        expect.anything(),
      );
    });

    it('busts the access cache AFTER the transaction commits, so a reader cannot re-cache pre-grant flags (X-01)', async () => {
      foundByPayment({
        id: 'req-x',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: FeatureKey.AI_ASSISTANT,
        tenant: { id: 't1' },
      });
      requests.save.mockImplementationOnce(async (r: any) => r);
      let committed = false;
      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        const out = await cb(dataSource.manager);
        committed = true;
        return out;
      });
      featureFlags.invalidateCache.mockImplementation(() => {
        expect(committed).toBe(true);
      });

      await listener.applyPaid('pay-1');

      expect(featureFlags.invalidateCache).toHaveBeenCalledWith('t1');
    });

    it('applies a usage-limit override with the admin-approved quantity', async () => {
      foundByPayment({
        id: 'req-2',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
        usage_metric: 'AI_TOKENS',
        approved_quantity: '50000',
        billing_period: 'monthly',
        tenant: { id: 't1' },
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      await listener.onPaymentSucceeded(
        new PaymentSucceededEvent('t1', 'pay-2', 300, 'SAR', undefined),
      );

      expect(limitOverrides.grantOrExtend).toHaveBeenCalledWith(
        't1',
        'AI_TOKENS',
        expect.objectContaining({
          overrideLimit: 50000,
          sourceRequestId: 'req-2',
        }),
        expect.anything(),
      );
    });

    it('refuses to grant an unknown feature key rather than writing a dead flag', async () => {
      // A request row created before the typed registry (or naming a renamed
      // capability) must fail loudly. Writing the flag anyway would leave a
      // customer who has PAID with a row that grants nothing.
      foundByPayment({
        id: 'req-3',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: 'ai_agent', // never existed in the catalog
        tenant: { id: 't1' },
      });

      await listener.onPaymentSucceeded(
        new PaymentSucceededEvent('t1', 'pay-3', 150.5, 'SAR', undefined),
      );

      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(requests.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: BILLING_UPGRADE_STATUS.COMPLETED }),
      );
    });

    it('is idempotent — a duplicate/re-delivered webhook does not re-apply the entitlement', async () => {
      foundByPayment({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.COMPLETED, // already applied by an earlier delivery
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: FeatureKey.AI_ASSISTANT,
        tenant: { id: 't1' },
      });

      await listener.onPaymentSucceeded(
        new PaymentSucceededEvent('t1', 'pay-1', 150.5, 'SAR', undefined),
      );

      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(requests.save).not.toHaveBeenCalled();
    });

    it('is a silent no-op for a payment that is not linked to any billing-upgrade request', async () => {
      foundByPayment(null);
      await expect(
        listener.onPaymentSucceeded(
          new PaymentSucceededEvent(
            't1',
            'unrelated-payment',
            10,
            'SAR',
            undefined,
          ),
        ),
      ).resolves.toBeUndefined();
      expect(featureFlags.set).not.toHaveBeenCalled();
    });

    it('never throws (and never leaves the request completed) when the entitlement write fails', async () => {
      foundByPayment({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: FeatureKey.AI_ASSISTANT,
        tenant: { id: 't1' },
      });
      featureFlags.set.mockRejectedValueOnce(new Error('db exploded'));

      await expect(
        listener.onPaymentSucceeded(
          new PaymentSucceededEvent('t1', 'pay-1', 150.5, 'SAR', undefined),
        ),
      ).resolves.toBeUndefined(); // caught & logged, never rethrown (must not fail the webhook response)
      expect(requests.save).not.toHaveBeenCalled(); // status flip never happened — no partial state
    });
  });

  describe('onPaymentFailed', () => {
    it('marks a payment_processing request as payment_failed without touching entitlements', async () => {
      foundByPayment({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      await listener.onPaymentFailed(
        new PaymentFailedEvent('t1', 'pay-1', undefined),
      );

      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: BILLING_UPGRADE_STATUS.PAYMENT_FAILED,
        }),
      );
      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(limitOverrides.grantOrExtend).not.toHaveBeenCalled();
    });

    it('leaves an already-terminal request untouched', async () => {
      foundByPayment({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.CANCELLED,
      });
      await listener.onPaymentFailed(
        new PaymentFailedEvent('t1', 'pay-1', undefined),
      );
      expect(requests.save).not.toHaveBeenCalled();
    });
  });

  // REL-005 — the durable `payments.outcome` consumer calls applyPaid/applyFailed
  // directly. They share one implementation with the event handlers, but unlike
  // the handlers they must THROW, so a failed apply is retried instead of lost.
  describe('applyPaid / applyFailed (REL-005 durable consumer)', () => {
    const feature = () => ({
      id: 'req-1',
      status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
      type: BILLING_UPGRADE_TYPE.FEATURE,
      feature_key: FeatureKey.AI_ASSISTANT,
      tenant: { id: 't1' },
    });

    it('applyPaid applies the grant exactly as the event handler does', async () => {
      foundByPayment(feature());
      requests.save.mockImplementationOnce(async (r: any) => r);

      await listener.applyPaid('pay-1');

      expect(featureFlags.set).toHaveBeenCalledWith(
        't1',
        FeatureKey.AI_ASSISTANT,
        true,
        expect.objectContaining({ source: FeatureFlagSource.BILLING_UPGRADE }),
      );
      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: BILLING_UPGRADE_STATUS.COMPLETED }),
      );
      // The lock is taken on the request row ALONE, filtering the raw FK column —
      // never findOne({ relations, lock }) / findOne({ where: { payment } , lock }),
      // which Postgres refuses ("FOR UPDATE cannot be applied to the nullable side
      // of an outer join").
      const qb = requests.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith(
        'request."paymentId" = :paymentId',
        {
          paymentId: 'pay-1',
        },
      );
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(requests.findOne).not.toHaveBeenCalledWith(
        expect.objectContaining({ lock: expect.anything() }),
      );
    });

    it('applyPaid is idempotent: an already-COMPLETED request is a no-op', async () => {
      foundByPayment({
        ...feature(),
        status: BILLING_UPGRADE_STATUS.COMPLETED,
      });
      await listener.applyPaid('pay-1');
      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(requests.save).not.toHaveBeenCalled();
    });

    it('applyPaid THROWS when the apply fails (so the job is retried)…', async () => {
      foundByPayment(feature());
      featureFlags.set.mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(listener.applyPaid('pay-1')).rejects.toThrow(
        'deadlock detected',
      );
    });

    it('…while the event handler swallows the SAME failure (it must not fail the webhook)', async () => {
      foundByPayment(feature());
      featureFlags.set.mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(
        listener.onPaymentSucceeded(
          new PaymentSucceededEvent('t1', 'pay-1', 150.5, 'SAR', undefined),
        ),
      ).resolves.toBeUndefined();
    });

    it('applyFailed moves a request still awaiting the payment to payment_failed', async () => {
      foundByPayment({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
      });
      requests.save.mockImplementationOnce(async (r: any) => r);
      await listener.applyFailed('pay-1');
      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: BILLING_UPGRADE_STATUS.PAYMENT_FAILED,
        }),
      );
    });

    it('applyFailed leaves a request that has since COMPLETED untouched (a late success is never regressed)', async () => {
      foundByPayment({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.COMPLETED,
      });
      await listener.applyFailed('pay-1');
      expect(requests.save).not.toHaveBeenCalled();
    });

    it('applyFailed THROWS on failure; the event handler swallows it', async () => {
      requests.createQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder();
        qb.getOne.mockRejectedValue(new Error('db down'));
        return qb;
      });
      await expect(listener.applyFailed('pay-1')).rejects.toThrow('db down');
      await expect(
        listener.onPaymentFailed(
          new PaymentFailedEvent('t1', 'pay-1', undefined),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('applyRefund (FIN-002)', () => {
    const build = (opts: {
      request: any;
      flag?: any;
      otherGrants?: number;
      overrideAffected?: number;
    }) => {
      const lockQb = createMockQueryBuilder();
      lockQb.getOne.mockResolvedValue(opts.request);
      const countQb = createMockQueryBuilder();
      countQb.getCount.mockResolvedValue(opts.otherGrants ?? 0);
      const reqRepo = createMockRepository();
      reqRepo.createQueryBuilder
        .mockReturnValueOnce(lockQb)
        .mockReturnValueOnce(countQb);
      reqRepo.findOne.mockResolvedValue(opts.request);
      const flagRepo = createMockRepository();
      flagRepo.findOne.mockResolvedValue(opts.flag ?? null);
      const execute = jest
        .fn()
        .mockResolvedValue({ affected: opts.overrideAffected ?? 0 });
      const updateQb: any = {};
      for (const m of ['update', 'set', 'where']) {
        updateQb[m] = jest.fn(() => updateQb);
      }
      updateQb.execute = execute;
      const overrideRepo: any = { createQueryBuilder: jest.fn(() => updateQb) };
      const manager: any = {
        getRepository: (e: unknown) =>
          e === BillingUpgradeRequest
            ? reqRepo
            : (e as { name?: string })?.name === 'FeatureFlag'
              ? flagRepo
              : overrideRepo,
      };
      const ds: any = { transaction: (cb: any) => cb(manager) };
      const l = new BillingUpgradeEntitlementListener(
        ds,
        featureFlags as any,
        limitOverrides as any,
        history as any,
      );
      return { l, execute };
    };
    const completedFeature = {
      id: 'req-1',
      status: BILLING_UPGRADE_STATUS.COMPLETED,
      type: BILLING_UPGRADE_TYPE.FEATURE,
      feature_key: FeatureKey.AI_ASSISTANT,
      tenant: { id: 't1' },
    };

    it('busts the access cache after commit when it revokes a flag (X-01)', async () => {
      const { l } = build({
        request: completedFeature,
        flag: { is_enabled: true, source: FeatureFlagSource.BILLING_UPGRADE },
      });
      await l.applyRefund('pay-1');
      expect(featureFlags.invalidateCache).toHaveBeenCalledWith('t1');
    });

    it('switches off the flag this upgrade granted', async () => {
      const { l } = build({
        request: completedFeature,
        flag: { is_enabled: true, source: FeatureFlagSource.BILLING_UPGRADE },
      });
      await l.applyRefund('pay-1');
      expect(featureFlags.set).toHaveBeenCalledWith(
        't1',
        FeatureKey.AI_ASSISTANT,
        false,
        expect.objectContaining({ source: FeatureFlagSource.BILLING_UPGRADE }),
      );
      expect(history.record).toHaveBeenCalledTimes(1);
    });

    it('leaves a flag a platform admin took over, or another completed grant', async () => {
      const a = build({
        request: completedFeature,
        flag: { is_enabled: true, source: FeatureFlagSource.PLATFORM_ADMIN },
      });
      await a.l.applyRefund('pay-1');
      const b = build({
        request: completedFeature,
        flag: { is_enabled: true, source: FeatureFlagSource.BILLING_UPGRADE },
        otherGrants: 1,
      });
      await b.l.applyRefund('pay-1');
      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
    });

    it('is a no-op for a request that never completed', async () => {
      const { l } = build({
        request: { ...completedFeature, status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING },
      });
      await l.applyRefund('pay-1');
      expect(featureFlags.set).not.toHaveBeenCalled();
    });

    it('deactivates the usage override granted by the request', async () => {
      const { l, execute } = build({
        request: {
          ...completedFeature,
          type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
          feature_key: undefined,
        },
        overrideAffected: 1,
      });
      await l.applyRefund('pay-1');
      expect(execute).toHaveBeenCalled();
      expect(history.record).toHaveBeenCalledTimes(1);
    });
  });
});

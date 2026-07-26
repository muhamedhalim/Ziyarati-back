import { BillingUpgradeEntitlementListener } from './billing-upgrade-entitlement.listener';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { PaymentFailedEvent, PaymentSucceededEvent } from '../../events/payment.events';
import { BILLING_UPGRADE_STATUS, BILLING_UPGRADE_TYPE } from './billing-upgrade.constants';
import {
  createMockDataSource,
  createMockEntityManager,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('BillingUpgradeEntitlementListener', () => {
  let listener: BillingUpgradeEntitlementListener;
  let requests: MockRepository;
  let dataSource: MockDataSource;
  let featureFlags: { set: jest.Mock };
  let limitOverrides: { grantOrExtend: jest.Mock };
  let history: { record: jest.Mock };
  const repoMap = new Map();

  beforeEach(() => {
    requests = createMockRepository();
    repoMap.set(BillingUpgradeRequest, requests);
    dataSource = createMockDataSource(createMockEntityManager(repoMap));
    dataSource.manager.getRepository = jest.fn(() => requests) as any;
    featureFlags = { set: jest.fn().mockResolvedValue(undefined) };
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

  describe('onPaymentSucceeded', () => {
    it('applies a feature grant and marks the request completed', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: 'ai_agent',
        tenant: { id: 't1' },
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      await listener.onPaymentSucceeded(
        new PaymentSucceededEvent('t1', 'pay-1', 150.5, 'SAR', undefined),
      );

      expect(featureFlags.set).toHaveBeenCalledWith('t1', 'ai_agent', true, expect.anything());
      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: BILLING_UPGRADE_STATUS.COMPLETED }),
      );
      expect(history.record).toHaveBeenCalledWith(
        expect.objectContaining({ toValue: BILLING_UPGRADE_STATUS.COMPLETED }),
        expect.anything(),
      );
    });

    it('applies a usage-limit override with the admin-approved quantity', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-2',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
        usage_metric: 'AI_TOKENS',
        approved_quantity: '50000',
        billing_period: 'monthly',
        tenant: { id: 't1' },
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      await listener.onPaymentSucceeded(new PaymentSucceededEvent('t1', 'pay-2', 300, 'SAR', undefined));

      expect(limitOverrides.grantOrExtend).toHaveBeenCalledWith(
        't1',
        'AI_TOKENS',
        expect.objectContaining({ overrideLimit: 50000, sourceRequestId: 'req-2' }),
        expect.anything(),
      );
    });

    it('is idempotent — a duplicate/re-delivered webhook does not re-apply the entitlement', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.COMPLETED, // already applied by an earlier delivery
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: 'ai_agent',
        tenant: { id: 't1' },
      });

      await listener.onPaymentSucceeded(
        new PaymentSucceededEvent('t1', 'pay-1', 150.5, 'SAR', undefined),
      );

      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(requests.save).not.toHaveBeenCalled();
    });

    it('is a silent no-op for a payment that is not linked to any billing-upgrade request', async () => {
      requests.findOne.mockResolvedValueOnce(null);
      await expect(
        listener.onPaymentSucceeded(new PaymentSucceededEvent('t1', 'unrelated-payment', 10, 'SAR', undefined)),
      ).resolves.toBeUndefined();
      expect(featureFlags.set).not.toHaveBeenCalled();
    });

    it('never throws (and never leaves the request completed) when the entitlement write fails', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
        type: BILLING_UPGRADE_TYPE.FEATURE,
        feature_key: 'ai_agent',
        tenant: { id: 't1' },
      });
      featureFlags.set.mockRejectedValueOnce(new Error('db exploded'));

      await expect(
        listener.onPaymentSucceeded(new PaymentSucceededEvent('t1', 'pay-1', 150.5, 'SAR', undefined)),
      ).resolves.toBeUndefined(); // caught & logged, never rethrown (must not fail the webhook response)
      expect(requests.save).not.toHaveBeenCalled(); // status flip never happened — no partial state
    });
  });

  describe('onPaymentFailed', () => {
    it('marks a payment_processing request as payment_failed without touching entitlements', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING,
      });
      requests.save.mockImplementationOnce(async (r: any) => r);

      await listener.onPaymentFailed(new PaymentFailedEvent('t1', 'pay-1', undefined));

      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: BILLING_UPGRADE_STATUS.PAYMENT_FAILED }),
      );
      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(limitOverrides.grantOrExtend).not.toHaveBeenCalled();
    });

    it('leaves an already-terminal request untouched', async () => {
      requests.findOne.mockResolvedValueOnce({
        id: 'req-1',
        status: BILLING_UPGRADE_STATUS.CANCELLED,
      });
      await listener.onPaymentFailed(new PaymentFailedEvent('t1', 'pay-1', undefined));
      expect(requests.save).not.toHaveBeenCalled();
    });
  });
});

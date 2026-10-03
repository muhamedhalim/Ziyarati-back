import { ConfigService } from '@nestjs/config';

import { OnlinePaymentCapabilityService } from './online-payment-capability.service';
import { PaymentsConfig } from './payments.config';
import { MERCHANT_ACCOUNT_STATUS as S } from './payments.constants';
import { MerchantAccount } from '../../entities/Payments/MerchantAccount';
import { createMockConfigService } from '../../../test/utils/mock-factories';

const TENANT = 't1';

const TAP_ON = {
  PAYMENT_PROVIDER: 'tap',
  TAP_ENV: 'sandbox',
  TAP_TEST_SECRET_KEY: 'sk_test_fake',
  TAP_PLATFORM_ID: 'commerce_platform_fake',
  TAP_BOOKING_PAYMENTS_ENABLED: 'true',
};

const approved = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  status: S.APPROVED,
  provider: 'tap',
  provider_recipient_id: 'merchant_abc123',
  ...over,
});

function build(env: Record<string, unknown>, row: unknown = null) {
  const findOne = jest.fn().mockResolvedValue(row);
  const repo = { findOne };
  const getRepository = jest.fn(() => repo);
  const manager = { getRepository };
  const config = new PaymentsConfig(
    createMockConfigService(env) as unknown as ConfigService,
  );
  const service = new OnlinePaymentCapabilityService(config, {
    manager,
  } as never);
  return { service, findOne, getRepository };
}

/**
 * The one answer to "can this clinic collect an online booking payment?". Every
 * caller — booking creation, pay-link issuing, the public pay page, every charge
 * — reads it, so these cases ARE the contract.
 */
describe('OnlinePaymentCapabilityService', () => {
  describe('NOT on Tap — adds no behaviour to a deployment that has not switched', () => {
    it.each(['moyasar', 'noop', ''])(
      'is always available for PAYMENT_PROVIDER=%p and never reads the database',
      async (provider) => {
        const { service, findOne } = build({ PAYMENT_PROVIDER: provider });
        expect(service.tapGoverned).toBe(false);
        expect(await service.resolve(TENANT)).toEqual({ available: true });
        expect(findOne).not.toHaveBeenCalled();
      },
    );
  });

  describe('on Tap', () => {
    it('is governed by Tap', () => {
      expect(build(TAP_ON).service.tapGoverned).toBe(true);
    });

    it('DISABLED while TAP_BOOKING_PAYMENTS_ENABLED is off — and the account is not even read', async () => {
      const { service, findOne } = build({
        ...TAP_ON,
        TAP_BOOKING_PAYMENTS_ENABLED: 'false',
      });
      expect(await service.resolve(TENANT)).toEqual({
        available: false,
        reason: 'DISABLED',
      });
      expect(findOne).not.toHaveBeenCalled();
    });

    it.each(['TAP_PLATFORM_ID', 'TAP_TEST_SECRET_KEY'])(
      'NOT_CONFIGURED without %s',
      async (missing) => {
        const { service, findOne } = build({ ...TAP_ON, [missing]: '' });
        expect(await service.resolve(TENANT)).toEqual({
          available: false,
          reason: 'NOT_CONFIGURED',
        });
        expect(findOne).not.toHaveBeenCalled();
      },
    );

    it('is available for an APPROVED Tap clinic and returns the merchant to charge on its behalf', async () => {
      const { service, getRepository, findOne } = build(TAP_ON, approved());
      expect(await service.resolve(TENANT)).toEqual({
        available: true,
        settlementMerchantId: 'merchant_abc123',
      });
      expect(getRepository).toHaveBeenCalledWith(MerchantAccount);
      expect(findOne).toHaveBeenCalledWith({
        where: { tenant: { id: TENANT } },
      });
    });

    it.each([
      ['no account row at all', null],
      [
        'an account still PENDING_DOCUMENTS',
        approved({ status: S.PENDING_DOCUMENTS }),
      ],
      ['an account UNDER_REVIEW', approved({ status: S.UNDER_REVIEW })],
      ['an account SUSPENDED by an admin', approved({ status: S.SUSPENDED })],
      ['an account REJECTED', approved({ status: S.REJECTED })],
      [
        'an approved account with NO merchant id',
        approved({ provider_recipient_id: undefined }),
      ],
      [
        'an approved account with a BLANK merchant id',
        approved({ provider_recipient_id: '   ' }),
      ],
      [
        'an approved account with a malformed merchant id',
        approved({ provider_recipient_id: 'mer chant;1' }),
      ],
      [
        'an account approved under ANOTHER provider',
        approved({ provider: 'moyasar' }),
      ],
    ])('CLINIC_NOT_ONBOARDED for %s', async (_label, row) => {
      const { service } = build(TAP_ON, row);
      expect(await service.resolve(TENANT)).toEqual({
        available: false,
        reason: 'CLINIC_NOT_ONBOARDED',
      });
    });

    it("reads through the CALLER'S manager, so a booking decides on its own transaction snapshot", async () => {
      const { service, findOne } = build(TAP_ON, approved());
      const otherFind = jest.fn().mockResolvedValue(approved());
      const txManager = { getRepository: () => ({ findOne: otherFind }) };
      await service.resolve(TENANT, txManager as never);
      expect(otherFind).toHaveBeenCalledTimes(1);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('trims a merchant id read from the database', async () => {
      const { service } = build(
        TAP_ON,
        approved({ provider_recipient_id: ' merchant_abc123 ' }),
      );
      expect(await service.resolve(TENANT)).toMatchObject({
        available: true,
        settlementMerchantId: 'merchant_abc123',
      });
    });
  });
});

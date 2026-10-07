import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MerchantAccountService } from './merchant-account.service';
import { OnlinePaymentCapabilityService } from './online-payment-capability.service';
import { MerchantAccount } from '../../entities/Payments/MerchantAccount';
import { PaymentsConfig } from './payments.config';
import { MERCHANT_ACCOUNT_STATUS as S } from './payments.constants';
import { ErrorCode } from '../../common/errors';
import {
  createMockConfigService,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('MerchantAccountService', () => {
  let accounts: MockRepository;

  const build = async (env: Record<string, unknown> = {}) => {
    accounts = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MerchantAccountService,
        { provide: getRepositoryToken(MerchantAccount), useValue: accounts },
        {
          provide: PaymentsConfig,
          useValue: new PaymentsConfig(
            createMockConfigService(env) as unknown as ConfigService,
          ),
        },
        {
          // The REAL capability rule over the same mock repository, so the Tap
          // gate below is exercised end to end rather than stubbed.
          provide: OnlinePaymentCapabilityService,
          useFactory: (config: PaymentsConfig) =>
            new OnlinePaymentCapabilityService(config, {
              manager: { getRepository: () => accounts },
            } as never),
          inject: [PaymentsConfig],
        },
      ],
    }).compile();
    return moduleRef.get(MerchantAccountService);
  };

  /** A deployment that has switched to Tap, with booking payments on. */
  const TAP_ENV_ON = {
    PAYMENT_PROVIDER: 'tap',
    TAP_ENV: 'sandbox',
    TAP_TEST_SECRET_KEY: 'sk_test_fake',
    TAP_PLATFORM_ID: 'commerce_platform_fake',
    TAP_WEBHOOK_URL: 'https://api.example.test/api/v1/payments/webhooks/tap',
    TAP_BOOKING_PAYMENTS_ENABLED: 'true',
  };
  const approvedTapAccount = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    status: S.APPROVED,
    provider: 'tap',
    provider_recipient_id: 'merchant_abc123',
    ...over,
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOrCreate', () => {
    it('lazily creates the NOT_STARTED row on first access', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce(null);
      const account = await service.getOrCreate(TENANT);
      expect(account.status).toBe(S.NOT_STARTED);
      expect(accounts.save).toHaveBeenCalled();
    });

    it('returns the racing winner on a unique(tenant) violation', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce(null);
      accounts.save.mockRejectedValueOnce({ code: '23505' });
      const winner = { id: 'm1', status: S.SUBMITTED };
      accounts.findOne.mockResolvedValueOnce(winner);
      expect(await service.getOrCreate(TENANT)).toBe(winner);
    });
  });

  describe('submit (clinic)', () => {
    it('masks the IBAN and moves NOT_STARTED → SUBMITTED with an audit entry', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.NOT_STARTED });
      const saved = await service.submit(TENANT, {
        bankName: 'Bank',
        beneficiaryName: 'Clinic LLC',
        iban: 'SA0380000000608010167519',
      });
      expect(saved.status).toBe(S.SUBMITTED);
      expect(saved.iban_masked).toBe('SA** **** 7519');
      expect(saved.iban_masked).not.toContain('608010');
      expect(saved.status_history?.at(-1)).toMatchObject({ from: S.NOT_STARTED, to: S.SUBMITTED });
    });

    it('rejects submission from a non-submittable status (e.g. APPROVED)', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.APPROVED });
      await expect(service.submit(TENANT, {})).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('review (platform admin)', () => {
    it('applies a legal transition and records the acting admin', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.SUBMITTED });
      const saved = await service.review(TENANT, { status: S.APPROVED }, 'admin-1');
      expect(saved.status).toBe(S.APPROVED);
      expect(saved.approved_at).toBeInstanceOf(Date);
      expect(saved.status_history?.at(-1)).toMatchObject({ to: S.APPROVED, by: 'admin-1' });
    });

    it('rejects an illegal transition (NOT_STARTED → APPROVED)', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.NOT_STARTED });
      await expect(
        service.review(TENANT, { status: S.APPROVED }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('records the gateway-issued recipient id', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.APPROVED });
      const saved = await service.review(TENANT, { providerRecipientId: 'rcp_1' });
      expect(saved.provider_recipient_id).toBe('rcp_1');
    });
  });

  describe('assertChargeable (marketplace gate)', () => {
    it('is a no-op when payments are not live (dev/test)', async () => {
      const service = await build({ PAYMENT_PROVIDER: 'noop' }); // simulator: not live
      await expect(service.assertChargeable(TENANT)).resolves.toBeUndefined();
      expect(accounts.findOne).not.toHaveBeenCalled();
    });
  });

  describe('review — hardening for Tap', () => {
    it('refuses a merchant id that is not a plain provider token (it ends up in charge requests and logs)', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.UNDER_REVIEW });
      await expect(
        service.review(TENANT, { providerRecipientId: 'merchant 1; DROP' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(accounts.save).not.toHaveBeenCalled();
    });

    it('refuses to APPROVE a Tap account that has no merchant id — "approved" must always mean chargeable', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({
        id: 'm1',
        status: S.UNDER_REVIEW,
        provider: 'tap',
      });
      await expect(
        service.review(TENANT, { status: S.APPROVED }, 'admin-1'),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(accounts.save).not.toHaveBeenCalled();
    });

    it('approves a Tap account once the merchant id is supplied in the same review, and audits BOTH changes', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce({
        id: 'm1',
        status: S.UNDER_REVIEW,
        provider: 'tap',
      });
      const saved = await service.review(
        TENANT,
        { status: S.APPROVED, providerRecipientId: 'merchant_abc123' },
        'admin-1',
      );
      expect(saved.status).toBe(S.APPROVED);
      expect(saved.provider_recipient_id).toBe('merchant_abc123');
      const notes = (saved.status_history ?? []).map((h) => h.note ?? h.to);
      expect(notes).toContain('Merchant id changed: (none) → merchant_abc123');
      expect(saved.status_history?.at(-1)).toMatchObject({ to: S.APPROVED, by: 'admin-1' });
    });

    it('changing the merchant id of an already-approved clinic (a money-routing change) leaves an attributable trail', async () => {
      const service = await build();
      accounts.findOne.mockResolvedValueOnce(approvedTapAccount());
      const saved = await service.review(
        TENANT,
        { providerRecipientId: 'merchant_other99' },
        'admin-2',
      );
      expect(saved.provider_recipient_id).toBe('merchant_other99');
      expect(saved.status_history?.at(-1)).toMatchObject({
        by: 'admin-2',
        note: 'Merchant id changed: merchant_abc123 → merchant_other99',
      });
    });
  });

  describe('Tap — assertChargeable / routingContext', () => {
    it('is ENFORCED outside production too: where patient money lands must not depend on NODE_ENV', async () => {
      const service = await build({ ...TAP_ENV_ON }); // NODE_ENV unset
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.NOT_STARTED, provider: 'tap' });
      await expect(service.assertChargeable(TENANT)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('refuses when the booking-payments flag is off — without reading the account', async () => {
      const service = await build({ ...TAP_ENV_ON, TAP_BOOKING_PAYMENTS_ENABLED: 'false' });
      await expect(service.assertChargeable(TENANT)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(accounts.findOne).not.toHaveBeenCalled();
    });

    it('allows an APPROVED Tap clinic with a merchant id, and routes its money to THAT merchant', async () => {
      const service = await build({ ...TAP_ENV_ON });
      accounts.findOne.mockResolvedValue(approvedTapAccount());
      await expect(service.assertChargeable(TENANT)).resolves.toBeUndefined();
      expect(await service.routingContext(TENANT)).toEqual({
        settlementMerchantId: 'merchant_abc123',
      });
    });

    it('does not treat a clinic approved under ANOTHER provider as chargeable on Tap', async () => {
      const service = await build({ ...TAP_ENV_ON });
      accounts.findOne.mockResolvedValue(approvedTapAccount({ provider: 'legacy-provider' }));
      await expect(service.assertChargeable(TENANT)).rejects.toBeDefined();
      expect(await service.routingContext(TENANT)).toBeNull();
    });

    it('routingContext is null (never throws) for a provider that does not route by merchant', async () => {
      const service = await build({ PAYMENT_PROVIDER: 'noop' });
      expect(await service.routingContext(TENANT)).toBeNull();
      expect(accounts.findOne).not.toHaveBeenCalled();
    });

  });

  describe('Tap — getClinicView / tapOnboardingConfigured', () => {
    it('lets a clinic ONBOARD before booking payments are switched on (only taking a payment waits for the flag)', async () => {
      const service = await build({ ...TAP_ENV_ON, TAP_BOOKING_PAYMENTS_ENABLED: 'false' });
      accounts.findOne.mockResolvedValue({ id: 'm1', status: S.NOT_STARTED, provider: 'tap' });
      const view = await service.getClinicView(TENANT);
      expect(view.online_payments).toEqual({
        provider: 'tap',
        onboarding_available: true,
        payments_available: false,
        reason: 'DISABLED',
      });
    });

    it('onboarding is unavailable without the platform id, a key or a webhook URL to receive Connect events on', async () => {
      for (const missing of ['TAP_PLATFORM_ID', 'TAP_TEST_SECRET_KEY', 'TAP_WEBHOOK_URL']) {
        const service = await build({ ...TAP_ENV_ON, [missing]: '' });
        expect(service.tapOnboardingConfigured()).toBe(false);
      }
      expect((await build({ ...TAP_ENV_ON })).tapOnboardingConfigured()).toBe(true);
      expect((await build({ PAYMENT_PROVIDER: 'noop' })).tapOnboardingConfigured()).toBe(false);
    });
  });

  describe('Tap — onboarding state machine', () => {
    it('claimTapOnboarding is a conditional UPDATE that reports whether THIS caller won', async () => {
      const service = await build();
      const qb = accounts.createQueryBuilder();
      accounts.createQueryBuilder.mockReturnValue(qb);
      qb.execute.mockResolvedValueOnce({ affected: 1 });
      expect(await service.claimTapOnboarding('m1')).toBe(true);
      qb.execute.mockResolvedValueOnce({ affected: 0 });
      expect(await service.claimTapOnboarding('m1')).toBe(false);
      // only an unclaimed or STALE claim may be taken
      expect(qb.andWhere.mock.calls[0][0]).toContain('provider_onboarding_claimed_at IS NULL OR');
    });

    it('a lead for an account that was on ANOTHER provider retires its recipient id into the audit trail and resets it to NOT_STARTED', async () => {
      const service = await build();
      const account = {
        id: 'm1',
        status: S.APPROVED,
        provider: 'legacy-provider',
        provider_recipient_id: 'rcp_legacy',
      } as never;
      const saved = await service.recordTapLeadCreated(account, 'led_1', 'user-1');
      expect(saved).toMatchObject({
        provider: 'tap',
        provider_lead_id: 'led_1',
        provider_recipient_id: undefined,
        status: S.NOT_STARTED,
      });
      expect(JSON.stringify(saved.status_history)).toContain('rcp_legacy');
    });

    it('a lead for an account already on Tap changes nothing but the lead id', async () => {
      const service = await build();
      const account = { id: 'm1', status: S.NOT_STARTED, provider: 'tap' } as never;
      const saved = await service.recordTapLeadCreated(account, 'led_2');
      expect(saved).toMatchObject({ provider: 'tap', provider_lead_id: 'led_2', status: S.NOT_STARTED });
      expect(saved.status_history ?? []).toHaveLength(0);
    });

    it('starting stores ONLY the token hash, releases the claim and moves the clinic to PENDING_DOCUMENTS', async () => {
      const service = await build();
      const account = { id: 'm1', status: S.NOT_STARTED, provider: 'tap' } as never;
      const saved = await service.recordTapOnboardingStarted(
        account,
        { leadId: 'led_1', callbackTokenHash: 'a'.repeat(64) },
        'user-1',
      );
      expect(saved).toMatchObject({
        status: S.PENDING_DOCUMENTS,
        provider_lead_id: 'led_1',
        provider_callback_token_hash: 'a'.repeat(64),
        provider_onboarding_claimed_at: null,
      });
      expect(saved.status_history?.at(-1)).toMatchObject({ to: S.PENDING_DOCUMENTS, by: 'user-1' });
    });

    it('re-issuing a link for a clinic already in PENDING_DOCUMENTS only swaps the token and leaves a note', async () => {
      const service = await build();
      const account = { id: 'm1', status: S.PENDING_DOCUMENTS, provider: 'tap' } as never;
      const saved = await service.recordTapOnboardingStarted(account, {
        leadId: 'led_1',
        callbackTokenHash: 'b'.repeat(64),
      });
      expect(saved.status).toBe(S.PENDING_DOCUMENTS);
      expect(saved.provider_callback_token_hash).toBe('b'.repeat(64));
      expect(saved.status_history?.at(-1)).toMatchObject({ note: 'Tap onboarding link issued' });
    });

    describe('recordTapOnboardingClaim (the callback — advisory only)', () => {
      const claim = {
        merchantId: 'merchant_abc123',
        isAcceptanceAllowed: true,
        isPayoutAllowed: false,
        recognised: true,
      };

      it('returns null for an unknown token, touching nothing', async () => {
        const service = await build();
        accounts.findOne.mockResolvedValueOnce(null);
        expect(await service.recordTapOnboardingClaim('f'.repeat(64), claim)).toBeNull();
        expect(accounts.save).not.toHaveBeenCalled();
      });

      it('records the claim and moves PENDING_DOCUMENTS → UNDER_REVIEW — but NEVER approves and NEVER sets the recipient id', async () => {
        const service = await build();
        accounts.findOne.mockResolvedValueOnce({
          id: 'm1',
          status: S.PENDING_DOCUMENTS,
          provider: 'tap',
        });
        const saved = (await service.recordTapOnboardingClaim('f'.repeat(64), claim))!;
        expect(saved.status).toBe(S.UNDER_REVIEW);
        expect(saved.provider_recipient_id).toBeUndefined();
        expect(saved.approved_at).toBeUndefined();
        expect(saved.provider_capabilities).toMatchObject({
          claim: { merchantId: 'merchant_abc123', isAcceptanceAllowed: true, recognised: true },
        });
      });

      it('on an APPROVED clinic a late/replayed callback changes neither status nor routing', async () => {
        const service = await build();
        accounts.findOne.mockResolvedValueOnce(approvedTapAccount());
        const saved = (await service.recordTapOnboardingClaim('f'.repeat(64), {
          ...claim,
          merchantId: 'merchant_evil',
        }))!;
        expect(saved.status).toBe(S.APPROVED);
        expect(saved.provider_recipient_id).toBe('merchant_abc123');
      });
    });
  });
});

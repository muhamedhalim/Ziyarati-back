import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MerchantAccountService } from './merchant-account.service';
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
      ],
    }).compile();
    return moduleRef.get(MerchantAccountService);
  };

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
      const service = await build(); // NODE_ENV unset ⇒ not live
      await expect(service.assertChargeable(TENANT)).resolves.toBeUndefined();
      expect(accounts.findOne).not.toHaveBeenCalled();
    });

    it('BLOCKS an unapproved clinic when payments are live', async () => {
      const service = await build({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' });
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.SUBMITTED });
      await expect(service.assertChargeable(TENANT)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('allows an APPROVED clinic when payments are live', async () => {
      const service = await build({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'moyasar' });
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.APPROVED });
      await expect(service.assertChargeable(TENANT)).resolves.toBeUndefined();
    });
  });

  describe('splitContext', () => {
    it('is null while the marketplace feature is not enabled', async () => {
      const service = await build({ MOYASAR_MARKETPLACE_ENABLED: 'false' });
      expect(await service.splitContext(TENANT)).toBeNull();
    });

    it('is null for an approved clinic with no recipient id', async () => {
      const service = await build({ MOYASAR_MARKETPLACE_ENABLED: 'true' });
      accounts.findOne.mockResolvedValueOnce({ id: 'm1', status: S.APPROVED });
      expect(await service.splitContext(TENANT)).toBeNull();
    });

    it('returns the recipient for an approved clinic when the feature is enabled', async () => {
      const service = await build({ MOYASAR_MARKETPLACE_ENABLED: 'true' });
      accounts.findOne.mockResolvedValueOnce({
        id: 'm1',
        status: S.APPROVED,
        provider_recipient_id: 'rcp_1',
      });
      expect(await service.splitContext(TENANT)).toEqual({ recipientId: 'rcp_1' });
    });
  });
});

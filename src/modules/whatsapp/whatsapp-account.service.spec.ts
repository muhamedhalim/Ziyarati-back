import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappAccountService } from './whatsapp-account.service';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('WhatsappAccountService', () => {
  let service: WhatsappAccountService;
  let accounts: MockRepository;
  let branches: MockRepository;

  beforeEach(async () => {
    accounts = createMockRepository();
    branches = createMockRepository();
    branches.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappAccountService,
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: getRepositoryToken(Branch), useValue: branches },
      ],
    }).compile();
    service = moduleRef.get(WhatsappAccountService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates an account and returns a SAFE view (no access_token)', async () => {
      accounts.findOne.mockResolvedValueOnce(null); // no existing same-mode account
      accounts.save.mockResolvedValueOnce({ id: 'acc-1' });
      accounts.findOne.mockResolvedValueOnce({ id: 'acc-1', access_token: 'secret', branch: { id: 'b1' } }); // findOne reload
      const res = (await service.create(TENANT, { branchId: 'b1', accessToken: 'secret' } as any)) as Record<string, unknown>;
      expect(res.access_token).toBeUndefined();
      expect(res.hasCredentials).toBe(true);
    });

    it('rejects an invalid branch with 422', async () => {
      branches.exists.mockResolvedValueOnce(false);
      await expect(service.create(TENANT, { branchId: 'x' } as any)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects a duplicate account for the same branch+mode', async () => {
      accounts.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create(TENANT, { branchId: 'b1' } as any)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });
  });

  describe('connectionStatus / findEntityForSend', () => {
    it('derives connection status from configured fields', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        is_active: true,
        access_token: 'secret',
        phone_number_id: 'pid',
        waba_id: 'wid',
        branch: { id: 'b1' },
      });
      const status = await service.connectionStatus(TENANT, 'acc-1');
      expect(status.connected).toBe(true);
    });

    it('findEntityForSend returns the raw active account', async () => {
      accounts.findOne.mockResolvedValueOnce({ id: 'acc-1', is_active: true, access_token: 'secret' });
      const entity = await service.findEntityForSend(TENANT, 'acc-1');
      expect(entity.access_token).toBe('secret');
    });

    it('findEntityForSend throws 404 when no account is found', async () => {
      accounts.findOne.mockResolvedValueOnce(null);
      await expect(service.findEntityForSend(TENANT)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('findEntityForSend rejects an inactive account with 422', async () => {
      accounts.findOne.mockResolvedValueOnce({ id: 'acc-1', is_active: false });
      await expect(service.findEntityForSend(TENANT, 'acc-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('mutations', () => {
    it('setActive toggles and remove soft-removes', async () => {
      accounts.findOne.mockResolvedValue({ id: 'acc-1', is_active: true, branch: { id: 'b1' } });
      await service.setActive(TENANT, 'acc-1', false);
      expect(accounts.save).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));

      await service.remove(TENANT, 'acc-1');
      expect(accounts.softRemove).toHaveBeenCalled();
    });

    it('findOne throws for an unknown account', async () => {
      accounts.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });
});

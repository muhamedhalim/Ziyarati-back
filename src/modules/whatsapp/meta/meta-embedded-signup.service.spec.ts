import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { MetaEmbeddedSignupService } from './meta-embedded-signup.service';
import { MetaConfig } from './meta.config';
import { MetaGraphClient } from './meta-graph.client';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { Branch } from '../../../entities/SaaS-Core/Branch';
import { ErrorCode } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { WHATSAPP_CONNECTION_STATUS } from '../whatsapp.constants';
import {
  createMockRepository,
  createMockConfigService,
  MockRepository,
} from '../../../../test/utils/mock-factories';

const TENANT = 't1';
const APP_ID = 'app-123';

const VALID_DTO = { code: 'auth-code', wabaId: 'waba-1' };

describe('MetaEmbeddedSignupService', () => {
  let service: MetaEmbeddedSignupService;
  let accounts: MockRepository;
  let branches: MockRepository;
  let graph: {
    exchangeCode: jest.Mock;
    debugToken: jest.Mock;
    getWaba: jest.Mock;
    listPhoneNumbers: jest.Mock;
    subscribeAppToWaba: jest.Mock;
  };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };

  beforeEach(async () => {
    accounts = createMockRepository();
    branches = createMockRepository();
    branches.exists.mockResolvedValue(true);
    accounts.create.mockImplementation((v: object) => ({ ...v }));
    accounts.save.mockImplementation(async (v: object) => ({ id: 'acc-1', ...v }));

    graph = {
      // Happy path by default; individual tests override one step to prove the gate.
      exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'real-token' }),
      debugToken: jest.fn().mockResolvedValue({
        appId: APP_ID,
        isValid: true,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      }),
      getWaba: jest.fn().mockResolvedValue({ id: 'waba-1', ownerBusinessId: 'biz-1' }),
      listPhoneNumbers: jest
        .fn()
        .mockResolvedValue([
          { id: 'pid-1', displayPhoneNumber: '+966 50 000 0000', verifiedName: 'Clinic' },
        ]),
      subscribeAppToWaba: jest.fn().mockResolvedValue(undefined),
    };
    encryption = {
      encrypt: jest.fn((v?: string) => (v ? `enc(${v})` : v)),
      decrypt: jest.fn((v?: string) => v),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MetaEmbeddedSignupService,
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: MetaGraphClient, useValue: graph },
        { provide: EncryptionService, useValue: encryption },
        {
          provide: MetaConfig,
          useValue: new MetaConfig(
            createMockConfigService({
              META_APP_ID: APP_ID,
              META_APP_SECRET: 'secret',
              META_EMBEDDED_SIGNUP_CONFIG_ID: 'cfg-1',
            }) as unknown as ConfigService,
          ),
        },
      ],
    }).compile();
    service = moduleRef.get(MetaEmbeddedSignupService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('publicConfig', () => {
    it('exposes ONLY the public identifiers — never the app secret', () => {
      const config = service.publicConfig();

      expect(config).toEqual({ appId: APP_ID, configId: 'cfg-1', graphVersion: 'v21.0' });
      expect(JSON.stringify(config)).not.toContain('secret');
    });
  });

  describe('the happy path', () => {
    it('runs the full flow in order and connects the account', async () => {
      const account = await service.complete(TENANT, VALID_DTO);

      expect(graph.exchangeCode).toHaveBeenCalledWith('auth-code');
      expect(graph.debugToken).toHaveBeenCalledWith('real-token');
      expect(graph.getWaba).toHaveBeenCalledWith('waba-1', 'real-token');
      // Without the subscription Meta never delivers this clinic's messages.
      expect(graph.subscribeAppToWaba).toHaveBeenCalledWith('waba-1', 'real-token');
      expect(account.connection_status).toBe(WHATSAPP_CONNECTION_STATUS.CONNECTED);
      expect(account.connected_at).toBeInstanceOf(Date);
    });

    it('stores the token ENCRYPTED and never in plaintext', async () => {
      const account = await service.complete(TENANT, VALID_DTO);

      expect(encryption.encrypt).toHaveBeenCalledWith('real-token');
      expect(account.access_token).toBe('enc(real-token)');
      expect(account.access_token).not.toBe('real-token');
    });

    it('persists under the AUTHENTICATED tenant, not anything from the request', async () => {
      await service.complete(TENANT, VALID_DTO);

      expect(accounts.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: { id: TENANT } }),
      );
    });

    it('records the Meta-reported business id over the client-supplied one', async () => {
      const account = await service.complete(TENANT, {
        ...VALID_DTO,
        metaBusinessId: 'client-claimed-biz',
      });

      // Meta's answer wins: the request body is untrusted.
      expect(account.meta_business_id).toBe('biz-1');
    });

    it('creates a TENANT-LEVEL number when no branch is given', async () => {
      const account = await service.complete(TENANT, VALID_DTO);
      expect(account.branch).toBeNull();
    });

    it('binds to a branch when one is given', async () => {
      const account = await service.complete(TENANT, { ...VALID_DTO, branchId: 'b-1' });
      expect(account.branch).toEqual({ id: 'b-1' });
    });

    it('makes the tenant\'s FIRST connected number its default', async () => {
      accounts.exists.mockResolvedValue(false); // no existing default

      await service.complete(TENANT, VALID_DTO);

      // Otherwise sending would fail right after onboarding for want of a default.
      expect(accounts.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ is_default: true }),
      );
    });

    it('does NOT steal the default from an existing number', async () => {
      accounts.exists.mockResolvedValue(true); // tenant already has a default

      const account = await service.complete(TENANT, VALID_DTO);

      expect(account.is_default).toBeFalsy();
    });
  });

  describe('token trust gate (the anti-replay check)', () => {
    it('REJECTS a token minted for a different Meta app', async () => {
      // The attack: replay a token from an app the attacker controls, so their
      // WABA gets attached to this tenant.
      graph.debugToken.mockResolvedValueOnce({
        appId: 'someone-elses-app',
        isValid: true,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      });

      await expect(service.complete(TENANT, VALID_DTO)).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
      expect(graph.subscribeAppToWaba).not.toHaveBeenCalled();
      expect(accounts.save).not.toHaveBeenCalled();
    });

    it('does not leak the foreign app id back to the caller', async () => {
      graph.debugToken.mockResolvedValueOnce({
        appId: 'someone-elses-app',
        isValid: true,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      });

      await expect(service.complete(TENANT, VALID_DTO)).rejects.not.toThrow(
        /someone-elses-app/,
      );
    });

    it('rejects a token Meta reports as invalid', async () => {
      graph.debugToken.mockResolvedValueOnce({ appId: APP_ID, isValid: false, scopes: [] });

      await expect(service.complete(TENANT, VALID_DTO)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects a token missing the messaging/management scopes', async () => {
      graph.debugToken.mockResolvedValueOnce({
        appId: APP_ID,
        isValid: true,
        scopes: ['public_profile'],
      });

      // Better to fail now than to "connect" and fail on the first send.
      await expect(service.complete(TENANT, VALID_DTO)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(accounts.save).not.toHaveBeenCalled();
    });
  });

  describe('asset ownership (the request body proves nothing)', () => {
    it('re-reads the WABA from Meta with the exchanged token', async () => {
      await service.complete(TENANT, VALID_DTO);
      expect(graph.getWaba).toHaveBeenCalledWith('waba-1', 'real-token');
    });

    it('fails when the token cannot actually read the claimed WABA', async () => {
      graph.getWaba.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: ErrorCode.UNPROCESSABLE_ENTITY }),
      );
      await expect(service.complete(TENANT, VALID_DTO)).rejects.toThrow();
      expect(accounts.save).not.toHaveBeenCalled();
    });

    it('rejects a phone number that is not on the connected WABA', async () => {
      await expect(
        service.complete(TENANT, { ...VALID_DTO, phoneNumberId: 'not-on-this-waba' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('auto-selects the number when the WABA has exactly one', async () => {
      const account = await service.complete(TENANT, VALID_DTO);
      expect(account.phone_number_id).toBe('pid-1');
    });

    it('refuses to GUESS when the WABA has several numbers', async () => {
      graph.listPhoneNumbers.mockResolvedValueOnce([
        { id: 'pid-1', displayPhoneNumber: '+9665 000' },
        { id: 'pid-2', displayPhoneNumber: '+9665 111' },
      ]);

      // Picking wrong would send the clinic's messages from the wrong identity.
      await expect(service.complete(TENANT, VALID_DTO)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('lists the numbers so the user can choose', async () => {
      graph.listPhoneNumbers.mockResolvedValueOnce([
        { id: 'pid-1', displayPhoneNumber: '+9665 000' },
        { id: 'pid-2', displayPhoneNumber: '+9665 111' },
      ]);

      await expect(service.complete(TENANT, VALID_DTO)).rejects.toMatchObject({
        publicContext: { phoneNumbers: [{ id: 'pid-1' }, { id: 'pid-2' }].map(expect.objectContaining) },
      });
    });

    it('rejects a WABA with no phone number at all', async () => {
      graph.listPhoneNumbers.mockResolvedValueOnce([]);

      await expect(service.complete(TENANT, VALID_DTO)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects a branch belonging to another tenant, before calling Meta', async () => {
      branches.exists.mockResolvedValueOnce(false);

      await expect(
        service.complete(TENANT, { ...VALID_DTO, branchId: 'foreign' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });
  });

  describe('multi-tenant isolation', () => {
    it('rejects connecting a number already held by ANOTHER tenant', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'other',
        tenant: { id: 'tenant-2' },
      });

      await expect(service.complete(TENANT, VALID_DTO)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      // Must not subscribe a WABA we are about to refuse.
      expect(graph.subscribeAppToWaba).not.toHaveBeenCalled();
    });

    it('does not reveal WHICH tenant holds the number', async () => {
      accounts.findOne.mockResolvedValueOnce({ id: 'other', tenant: { id: 'tenant-2' } });

      await expect(service.complete(TENANT, VALID_DTO)).rejects.not.toThrow(/tenant-2/);
    });

    it('allows the SAME tenant to reconnect its own number (token refresh)', async () => {
      accounts.findOne
        .mockResolvedValueOnce({ id: 'acc-1', tenant: { id: TENANT } }) // availability
        .mockResolvedValueOnce({ id: 'acc-1', tenant: { id: TENANT } }); // upsert target

      const account = await service.complete(TENANT, VALID_DTO);

      // Reconnect must UPDATE, not insert a duplicate the unique index rejects.
      expect(account.id).toBe('acc-1');
      expect(account.access_token).toBe('enc(real-token)');
    });
  });

  describe('token expiry', () => {
    it('treats a long-lived System User token (no expiry) as non-expiring', async () => {
      const account = await service.complete(TENANT, VALID_DTO);
      expect(account.token_expires_at).toBeUndefined();
    });

    it('prefers debug_token\'s expires_at over the exchange\'s expires_in', async () => {
      const at = Math.floor(Date.now() / 1000) + 3600;
      graph.exchangeCode.mockResolvedValueOnce({
        accessToken: 'real-token',
        expiresInSeconds: 60,
      });
      graph.debugToken.mockResolvedValueOnce({
        appId: APP_ID,
        isValid: true,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        expiresAt: at,
      });

      const account = await service.complete(TENANT, VALID_DTO);

      // The introspected value is authoritative.
      expect(account.token_expires_at?.getTime()).toBe(at * 1000);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappCoexistenceSyncService } from './whatsapp-coexistence-sync.service';
import { MetaGraphClient } from './meta-graph.client';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../../test/utils/mock-factories';

const TENANT = 't1';

const baseAccount = (overrides: Partial<WhatsappAccount> = {}) => ({
  id: 'acc-1',
  onboarding_type: 'COEXISTENCE',
  phone_number_id: 'pid-1',
  access_token: 'enc(real-token)',
  coexistence_state_sync_status: null,
  coexistence_history_sync_status: null,
  ...overrides,
});

describe('WhatsappCoexistenceSyncService', () => {
  let service: WhatsappCoexistenceSyncService;
  let accounts: MockRepository;
  let graph: { triggerSmbAppDataSync: jest.Mock };
  let encryption: { decrypt: jest.Mock };

  beforeEach(async () => {
    accounts = createMockRepository();
    graph = { triggerSmbAppDataSync: jest.fn().mockResolvedValue(undefined) };
    encryption = {
      decrypt: jest.fn((v: string) => v.replace(/^enc\(|\)$/g, '')),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappCoexistenceSyncService,
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: MetaGraphClient, useValue: graph },
        { provide: EncryptionService, useValue: encryption },
      ],
    }).compile();
    service = moduleRef.get(WhatsappCoexistenceSyncService);
  });

  afterEach(() => jest.clearAllMocks());

  it('is a no-op for an account that is not COEXISTENCE (never touches a STANDARD number)', async () => {
    accounts.findOne.mockResolvedValueOnce(
      baseAccount({ onboarding_type: 'STANDARD' }),
    );

    const res = await service.run(TENANT, 'acc-1');

    expect(res).toEqual({ ran: false, reason: 'not-coexistence' });
    expect(graph.triggerSmbAppDataSync).not.toHaveBeenCalled();
  });

  it('is a no-op when the account cannot be found for this tenant', async () => {
    accounts.findOne.mockResolvedValueOnce(null);

    const res = await service.run(TENANT, 'missing');

    expect(res).toEqual({ ran: false, reason: 'account-not-found' });
  });

  it('triggers state_sync THEN history, in that order, with the decrypted token', async () => {
    accounts.findOne.mockResolvedValueOnce(baseAccount());

    await service.run(TENANT, 'acc-1');

    expect(graph.triggerSmbAppDataSync).toHaveBeenNthCalledWith(
      1,
      'pid-1',
      'real-token',
      'smb_app_state_sync',
    );
    expect(graph.triggerSmbAppDataSync).toHaveBeenNthCalledWith(
      2,
      'pid-1',
      'real-token',
      'history',
    );
  });

  it('marks each step IN_PROGRESS after a successful trigger — NOT COMPLETED (the webhook confirms that)', async () => {
    accounts.findOne.mockResolvedValueOnce(baseAccount());

    await service.run(TENANT, 'acc-1');

    expect(accounts.update).toHaveBeenCalledWith('acc-1', {
      coexistence_state_sync_status: 'IN_PROGRESS',
    });
    expect(accounts.update).toHaveBeenCalledWith('acc-1', {
      coexistence_history_sync_status: 'IN_PROGRESS',
    });
    expect(accounts.update).not.toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ coexistence_state_sync_status: 'COMPLETED' }),
    );
  });

  describe('idempotency — do not re-run a completed or in-flight step', () => {
    it('skips state_sync entirely when already COMPLETED, but still runs history', async () => {
      accounts.findOne.mockResolvedValueOnce(
        baseAccount({ coexistence_state_sync_status: 'COMPLETED' }),
      );

      await service.run(TENANT, 'acc-1');

      expect(graph.triggerSmbAppDataSync).toHaveBeenCalledTimes(1);
      expect(graph.triggerSmbAppDataSync).toHaveBeenCalledWith(
        'pid-1',
        'real-token',
        'history',
      );
    });

    it('skips a step already IN_PROGRESS (an earlier trigger is still awaiting webhook confirmation)', async () => {
      accounts.findOne.mockResolvedValueOnce(
        baseAccount({ coexistence_state_sync_status: 'IN_PROGRESS' }),
      );

      await service.run(TENANT, 'acc-1');

      expect(graph.triggerSmbAppDataSync).toHaveBeenCalledTimes(1);
      expect(graph.triggerSmbAppDataSync).toHaveBeenCalledWith(
        'pid-1',
        'real-token',
        'history',
      );
    });

    it('runs nothing when BOTH steps are already COMPLETED (re-onboarding-only per Meta docs)', async () => {
      accounts.findOne.mockResolvedValueOnce(
        baseAccount({
          coexistence_state_sync_status: 'COMPLETED',
          coexistence_history_sync_status: 'COMPLETED',
        }),
      );

      const res = await service.run(TENANT, 'acc-1');

      expect(graph.triggerSmbAppDataSync).not.toHaveBeenCalled();
      expect(res).toEqual({ ran: true });
    });
  });

  describe('failure / retry', () => {
    it('records the failure and RETHROWS (so BullMQ retries) when the state_sync trigger fails', async () => {
      accounts.findOne.mockResolvedValueOnce(baseAccount());
      graph.triggerSmbAppDataSync.mockRejectedValueOnce(
        new Error('Meta rejected the request'),
      );

      await expect(service.run(TENANT, 'acc-1')).rejects.toThrow(
        'Meta rejected the request',
      );

      expect(accounts.update).toHaveBeenCalledWith('acc-1', {
        coexistence_state_sync_status: 'FAILED',
        coexistence_last_sync_error: 'Meta rejected the request',
      });
      // History must never run before state_sync has actually succeeded.
      expect(graph.triggerSmbAppDataSync).toHaveBeenCalledTimes(1);
    });

    it('records the failure and rethrows when the history trigger fails (state_sync already succeeded)', async () => {
      accounts.findOne.mockResolvedValueOnce(baseAccount());
      graph.triggerSmbAppDataSync
        .mockResolvedValueOnce(undefined) // state_sync ok
        .mockRejectedValueOnce(new Error('timeout')); // history fails

      await expect(service.run(TENANT, 'acc-1')).rejects.toThrow('timeout');

      expect(accounts.update).toHaveBeenCalledWith('acc-1', {
        coexistence_history_sync_status: 'FAILED',
        coexistence_last_sync_error: 'timeout',
      });
    });

    it('a retried run after a FAILED step tries again (FAILED is not a terminal skip state)', async () => {
      accounts.findOne.mockResolvedValueOnce(
        baseAccount({ coexistence_state_sync_status: 'FAILED' }),
      );

      await service.run(TENANT, 'acc-1');

      expect(graph.triggerSmbAppDataSync).toHaveBeenCalledWith(
        'pid-1',
        'real-token',
        'smb_app_state_sync',
      );
    });
  });

  it('is a no-op when the account has no phone number / token yet (not actually connected)', async () => {
    accounts.findOne.mockResolvedValueOnce(
      baseAccount({ phone_number_id: undefined, access_token: undefined }),
    );

    const res = await service.run(TENANT, 'acc-1');

    expect(res).toEqual({ ran: false, reason: 'account-not-connected' });
    expect(graph.triggerSmbAppDataSync).not.toHaveBeenCalled();
  });
});

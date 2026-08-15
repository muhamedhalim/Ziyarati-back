import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { WhatsappAccountService } from './whatsapp-account.service';
import { WhatsappAccountResolver } from './routing/whatsapp-account.resolver';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { ErrorCode } from '../../common/errors';
import {
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_CONNECTION_STATUS,
  WHATSAPP_PROVIDER,
} from './whatsapp.constants';
import {
  createMockRepository,
  createMockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('WhatsappAccountService', () => {
  let service: WhatsappAccountService;
  let accounts: MockRepository;
  let branches: MockRepository;
  let resolver: { usableAccounts: jest.Mock };
  let dataSource: ReturnType<typeof createMockDataSource>;

  beforeEach(async () => {
    accounts = createMockRepository();
    branches = createMockRepository();
    branches.exists.mockResolvedValue(true);
    // `findEligible` delegates here so eligibility has ONE definition shared
    // with the send path.
    resolver = { usableAccounts: jest.fn().mockResolvedValue([]) };
    dataSource = createMockDataSource();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappAccountService,
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: WhatsappAccountResolver, useValue: resolver },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(WhatsappAccountService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates an UNCONNECTED slot — credentials only come from Embedded Signup', async () => {
      accounts.save.mockResolvedValueOnce({ id: 'acc-1' });
      accounts.findOne.mockResolvedValueOnce({ id: 'acc-1', branch: { id: 'b1' } });

      await service.create(TENANT, { branchId: 'b1' } as never);

      expect(accounts.create).toHaveBeenCalledWith(
        expect.objectContaining({
          connection_status: WHATSAPP_CONNECTION_STATUS.PENDING,
          provider: WHATSAPP_PROVIDER.META_CLOUD,
          mode: WHATSAPP_ACCOUNT_MODE.CUSTOM,
        }),
      );
    });

    it('returns a SAFE view that never contains the access token', async () => {
      accounts.save.mockResolvedValueOnce({ id: 'acc-1' });
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        access_token: 'enc:v1:secret',
        branch: { id: 'b1' },
      });

      const res = (await service.create(TENANT, { branchId: 'b1' } as never)) as Record<
        string,
        unknown
      >;

      expect(res.access_token).toBeUndefined();
      expect(res.hasCredentials).toBe(true);
    });

    it('creates a TENANT-LEVEL account when no branch is given', async () => {
      accounts.save.mockResolvedValueOnce({ id: 'acc-1' });
      accounts.findOne.mockResolvedValueOnce({ id: 'acc-1' });

      await service.create(TENANT, {} as never);

      // branch === null ⇒ usable by every branch (see the entity docs).
      expect(accounts.create).toHaveBeenCalledWith(
        expect.objectContaining({ branch: null }),
      );
    });

    it('rejects a branch from another tenant with 422', async () => {
      branches.exists.mockResolvedValueOnce(false);
      await expect(service.create(TENANT, { branchId: 'x' } as never)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('default account selection', () => {
    it('unsets the previous default and sets the new one in ONE transaction', async () => {
      accounts.findOne.mockResolvedValue({ id: 'acc-2', is_active: true, branch: null });

      await service.setDefault(TENANT, 'acc-2');

      // The DB enforces at most one live default per tenant, so a set without
      // the unset in the same transaction would violate the unique index.
      expect(dataSource.transaction).toHaveBeenCalled();
      const mgr = dataSource.manager;
      expect(mgr.update).toHaveBeenCalledWith(
        WhatsappAccount,
        expect.objectContaining({ is_default: true }),
        { is_default: false },
      );
      expect(mgr.update).toHaveBeenCalledWith(
        WhatsappAccount,
        { id: 'acc-2' },
        { is_default: true },
      );
    });

    it('refuses to make an inactive account the default', async () => {
      accounts.findOne.mockResolvedValueOnce({ id: 'acc-2', is_active: false, branch: null });

      await expect(service.setDefault(TENANT, 'acc-2')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('clears the default flag when an account is deactivated', async () => {
      accounts.findOne.mockResolvedValue({
        id: 'acc-1',
        is_active: true,
        is_default: true,
        branch: null,
      });

      await service.setActive(TENANT, 'acc-1', false);

      // Otherwise the resolver would keep selecting a number that is switched off.
      expect(accounts.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: false, is_default: false }),
      );
    });
  });

  describe('tenant isolation', () => {
    it('scopes every lookup to the caller\'s tenant', async () => {
      accounts.findOne.mockResolvedValueOnce({ id: 'acc-1', branch: null });

      await service.findOne(TENANT, 'acc-1');

      expect(accounts.findOne.mock.calls[0][0].where).toMatchObject({
        id: 'acc-1',
        tenant: { id: TENANT },
      });
    });

    it('returns 404 for another tenant\'s account', async () => {
      accounts.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(TENANT, 'foreign')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('connectionStatus', () => {
    it('reports connected for an active, CONNECTED account with credentials', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        is_active: true,
        access_token: 'enc:v1:x',
        phone_number_id: 'pid',
        waba_id: 'wid',
        connection_status: WHATSAPP_CONNECTION_STATUS.CONNECTED,
        branch: null,
      });

      expect((await service.connectionStatus(TENANT, 'acc-1')).connected).toBe(true);
    });

    it('reports EXPIRED (not connected) once the token expiry has passed', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        is_active: true,
        access_token: 'enc:v1:x',
        phone_number_id: 'pid',
        waba_id: 'wid',
        connection_status: WHATSAPP_CONNECTION_STATUS.CONNECTED,
        token_expires_at: new Date(Date.now() - 1000),
        branch: null,
      });

      const status = await service.connectionStatus(TENANT, 'acc-1');

      // The stored status still says CONNECTED; expiry is derived, so the UI
      // can tell the clinic to reconnect rather than just "not connected".
      expect(status.connectionStatus).toBe(WHATSAPP_CONNECTION_STATUS.EXPIRED);
      expect(status.connected).toBe(false);
    });

    it('is not connected while onboarding is still PENDING', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        is_active: true,
        connection_status: WHATSAPP_CONNECTION_STATUS.PENDING,
        branch: null,
      });

      expect((await service.connectionStatus(TENANT, 'acc-1')).connected).toBe(false);
    });
  });

  describe('disconnect', () => {
    const connected = () => ({
      id: 'acc-1',
      branch: null,
      is_active: true,
      is_default: true,
      access_token: 'enc:v1:secret',
      connection_status: WHATSAPP_CONNECTION_STATUS.CONNECTED,
    });

    it('marks the account DISCONNECTED so the sender refuses it', async () => {
      accounts.findOne.mockResolvedValue(connected());

      await service.disconnect(TENANT, 'acc-1');

      expect(accounts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          connection_status: WHATSAPP_CONNECTION_STATUS.DISCONNECTED,
        }),
      );
    });

    it('stops the account being the default', async () => {
      accounts.findOne.mockResolvedValue(connected());

      await service.disconnect(TENANT, 'acc-1');

      // A number that cannot send must not be what everything falls back to.
      expect(accounts.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_default: false }),
      );
    });

    it('PRESERVES the row and its history — it is not a delete', async () => {
      accounts.findOne.mockResolvedValue(connected());

      await service.disconnect(TENANT, 'acc-1');

      // Conversations/campaigns/audit rows reference this account.
      expect(accounts.softRemove).not.toHaveBeenCalled();
      expect(accounts.delete).not.toHaveBeenCalled();
    });

    it('keeps the credential (blocking comes from status, not a wiped token)', async () => {
      accounts.findOne.mockResolvedValue(connected());

      await service.disconnect(TENANT, 'acc-1');

      // Reconnect overwrites it anyway; wiping here buys nothing and makes
      // diagnosing a failed disconnect harder. It stays encrypted at rest.
      expect(accounts.save).toHaveBeenCalledWith(
        expect.objectContaining({ access_token: 'enc:v1:secret' }),
      );
    });

    it('is tenant-scoped — another tenant\'s account is a 404', async () => {
      accounts.findOne.mockResolvedValueOnce(null);
      await expect(service.disconnect(TENANT, 'foreign')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('is idempotent for an already-disconnected account', async () => {
      accounts.findOne.mockResolvedValue({
        ...connected(),
        is_default: false,
        connection_status: WHATSAPP_CONNECTION_STATUS.DISCONNECTED,
      });

      await expect(service.disconnect(TENANT, 'acc-1')).resolves.toBeDefined();
    });
  });

  describe('findEligible', () => {
    it('delegates eligibility to the resolver — one definition, two readers', async () => {
      resolver.usableAccounts.mockResolvedValueOnce([{ id: 'acc-1' }]);
      accounts.find.mockResolvedValueOnce([{ id: 'acc-1', branch: null }]);

      await service.findEligible(TENANT);

      // If the UI applied its own rules they would drift from the sender's.
      expect(resolver.usableAccounts).toHaveBeenCalledWith(TENANT);
    });

    it('returns SAFE views only (no access token)', async () => {
      resolver.usableAccounts.mockResolvedValueOnce([{ id: 'acc-1' }]);
      accounts.find.mockResolvedValueOnce([
        { id: 'acc-1', branch: null, access_token: 'enc:v1:secret' },
      ]);

      const [view] = (await service.findEligible(TENANT)) as Record<string, unknown>[];

      expect(view.access_token).toBeUndefined();
      expect(view.hasCredentials).toBe(true);
    });

    it('returns an empty list when nothing can send', async () => {
      resolver.usableAccounts.mockResolvedValueOnce([]);
      accounts.find.mockResolvedValueOnce([]);

      await expect(service.findEligible(TENANT)).resolves.toEqual([]);
    });
  });

  describe('remove', () => {
    it('soft-removes so the phone number can be reconnected later', async () => {
      accounts.findOne.mockResolvedValue({ id: 'acc-1', branch: null });

      await service.remove(TENANT, 'acc-1');

      // The phone_number_id unique index is partial on deleted_at IS NULL.
      expect(accounts.softRemove).toHaveBeenCalled();
    });

    it('never hard-deletes — history in conversations/templates/campaigns must survive', async () => {
      accounts.findOne.mockResolvedValue({ id: 'acc-1', branch: null });

      await service.remove(TENANT, 'acc-1');

      expect(accounts.delete).not.toHaveBeenCalled();
      expect(accounts.remove).not.toHaveBeenCalled();
    });

    it('is tenant-scoped — another tenant\'s account is a 404, never removed', async () => {
      accounts.findOne.mockResolvedValueOnce(null);

      await expect(service.remove(TENANT, 'foreign')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(accounts.softRemove).not.toHaveBeenCalled();
    });
  });
});

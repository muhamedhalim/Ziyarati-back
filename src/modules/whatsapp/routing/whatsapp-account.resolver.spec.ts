import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappAccountResolver } from './whatsapp-account.resolver';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { ErrorCode } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { WHATSAPP_ACCOUNT_MODE, WHATSAPP_CONNECTION_STATUS } from '../whatsapp.constants';
import { createMockRepository, MockRepository } from '../../../../test/utils/mock-factories';

const TENANT = 't1';

/** A live, usable account row. */
function account(overrides: Partial<WhatsappAccount> = {}): WhatsappAccount {
  return {
    id: 'acc-1',
    mode: WHATSAPP_ACCOUNT_MODE.CUSTOM,
    phone_number_id: 'pid-1',
    waba_id: 'waba-1',
    access_token: 'enc(token-1)',
    is_active: true,
    connection_status: WHATSAPP_CONNECTION_STATUS.CONNECTED,
    ...overrides,
  } as WhatsappAccount;
}

describe('WhatsappAccountResolver', () => {
  let resolver: WhatsappAccountResolver;
  let accounts: MockRepository;

  beforeEach(async () => {
    accounts = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappAccountResolver,
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        {
          provide: EncryptionService,
          useValue: { decrypt: jest.fn((v?: string) => v?.replace(/^enc\((.*)\)$/, '$1')) },
        },
      ],
    }).compile();
    resolver = moduleRef.get(WhatsappAccountResolver);
  });

  afterEach(() => jest.clearAllMocks());

  describe('byId', () => {
    it('decrypts the stored credential for the delivery adapter', async () => {
      accounts.findOne.mockResolvedValueOnce(account());

      const resolved = await resolver.byId(TENANT, 'acc-1');

      expect(resolved.accessToken).toBe('token-1');
      expect(resolved.phoneNumberId).toBe('pid-1');
    });

    it('scopes the lookup to the caller\'s tenant', async () => {
      accounts.findOne.mockResolvedValueOnce(account());

      await resolver.byId(TENANT, 'acc-1');

      expect(accounts.findOne.mock.calls[0][0].where).toMatchObject({
        id: 'acc-1',
        tenant: { id: TENANT },
      });
    });

    it('throws 404 for an unknown/foreign account', async () => {
      accounts.findOne.mockResolvedValueOnce(null);
      await expect(resolver.byId(TENANT, 'acc-x')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('rejects an inactive account', async () => {
      accounts.findOne.mockResolvedValueOnce(account({ is_active: false }));
      await expect(resolver.byId(TENANT, 'acc-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects an expired token', async () => {
      accounts.findOne.mockResolvedValueOnce(
        account({ token_expires_at: new Date(Date.now() - 1000) }),
      );
      await expect(resolver.byId(TENANT, 'acc-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('forBranch', () => {
    it('prefers the branch CUSTOM account over its PLATFORM account', async () => {
      const custom = account({ id: 'custom-1', mode: WHATSAPP_ACCOUNT_MODE.CUSTOM });
      accounts.findOne.mockResolvedValueOnce(custom);

      const resolved = await resolver.forBranch(TENANT, 'b-1');

      expect(resolved.id).toBe('custom-1');
      expect(resolved.source).toBe('CUSTOM');
      // Short-circuits: the PLATFORM lookup never runs.
      expect(accounts.findOne).toHaveBeenCalledTimes(1);
    });

    it('falls back to the branch PLATFORM account when no CUSTOM exists', async () => {
      accounts.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(account({ id: 'plat-1', mode: WHATSAPP_ACCOUNT_MODE.PLATFORM }));

      const resolved = await resolver.forBranch(TENANT, 'b-1');

      expect(resolved.id).toBe('plat-1');
      expect(resolved.source).toBe('PLATFORM');
    });

    it('falls back to the tenant default when the branch has no account', async () => {
      accounts.findOne.mockResolvedValue(null);
      accounts.find.mockResolvedValueOnce([account({ id: 'tenant-default' })]);

      const resolved = await resolver.forBranch(TENANT, 'b-1');

      expect(resolved.id).toBe('tenant-default');
    });

    it('skips a branch account whose token has expired', async () => {
      accounts.findOne
        .mockResolvedValueOnce(account({ token_expires_at: new Date(Date.now() - 1000) }))
        .mockResolvedValueOnce(null);
      accounts.find.mockResolvedValueOnce([account({ id: 'tenant-default' })]);

      const resolved = await resolver.forBranch(TENANT, 'b-1');

      expect(resolved.id).toBe('tenant-default');
    });
  });

  describe('forTenant (multi-number selection)', () => {
    it('uses the account explicitly flagged as default', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ id: 'older-custom', mode: WHATSAPP_ACCOUNT_MODE.CUSTOM }),
        account({ id: 'chosen', is_default: true }),
      ]);

      // The operator's stated choice beats every heuristic.
      expect((await resolver.forTenant(TENANT)).id).toBe('chosen');
    });

    it('uses the only usable account without needing a default', async () => {
      accounts.find.mockResolvedValueOnce([account({ id: 'only-one' })]);
      expect((await resolver.forTenant(TENANT)).id).toBe('only-one');
    });

    it('falls back to CUSTOM-then-oldest ONLY when several exist and none is default', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ id: 'plat-1', mode: WHATSAPP_ACCOUNT_MODE.PLATFORM }),
        account({ id: 'custom-1', mode: WHATSAPP_ACCOUNT_MODE.CUSTOM }),
      ]);

      // A clinic's own number outranks a platform-provisioned one.
      expect((await resolver.forTenant(TENANT)).id).toBe('custom-1');
    });

    it('is deterministic (oldest first) when only PLATFORM accounts exist', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ id: 'older', mode: WHATSAPP_ACCOUNT_MODE.PLATFORM }),
        account({ id: 'newer', mode: WHATSAPP_ACCOUNT_MODE.PLATFORM }),
      ]);

      expect((await resolver.forTenant(TENANT)).id).toBe('older');
      expect(accounts.find.mock.calls[0][0].order).toMatchObject({ created_at: 'ASC' });
    });

    it('ignores a default that is not usable and picks a usable account', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ id: 'broken-default', is_default: true, access_token: undefined }),
        account({ id: 'usable' }),
      ]);

      // An unusable default must not strand the tenant.
      expect((await resolver.forTenant(TENANT)).id).toBe('usable');
    });

    it('ignores accounts with no phone number or no credential', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ id: 'no-pid', phone_number_id: undefined }),
        account({ id: 'no-token', access_token: undefined }),
        account({ id: 'usable' }),
      ]);

      expect((await resolver.forTenant(TENANT)).id).toBe('usable');
    });

    it('scopes to the tenant and to live, active rows only', async () => {
      accounts.find.mockResolvedValueOnce([account()]);

      await resolver.forTenant(TENANT);

      expect(accounts.find.mock.calls[0][0].where).toMatchObject({
        tenant: { id: TENANT },
        is_active: true,
      });
    });
  });

  describe('disconnect is enforced on the SEND path', () => {
    it.each([
      WHATSAPP_CONNECTION_STATUS.DISCONNECTED,
      WHATSAPP_CONNECTION_STATUS.REVOKED,
      WHATSAPP_CONNECTION_STATUS.EXPIRED,
      WHATSAPP_CONNECTION_STATUS.PENDING,
    ])('refuses to send from a %s account', async (status) => {
      // Disconnect deliberately KEEPS the credentials on the row, so blocking
      // must come from connection_status — not from a missing token.
      accounts.findOne.mockResolvedValueOnce(account({ connection_status: status }));

      await expect(resolver.byId(TENANT, 'acc-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('excludes a disconnected account from the tenant\'s usable set', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ id: 'disconnected', connection_status: WHATSAPP_CONNECTION_STATUS.DISCONNECTED }),
        account({ id: 'live' }),
      ]);

      expect((await resolver.forTenant(TENANT)).id).toBe('live');
    });

    it('ignores a disconnected DEFAULT rather than sending through it', async () => {
      accounts.find.mockResolvedValueOnce([
        account({
          id: 'default-but-dead',
          is_default: true,
          connection_status: WHATSAPP_CONNECTION_STATUS.DISCONNECTED,
        }),
        account({ id: 'live' }),
      ]);

      expect((await resolver.forTenant(TENANT)).id).toBe('live');
    });

    it('falls through to the tenant default when the BRANCH number is disconnected', async () => {
      accounts.findOne
        .mockResolvedValueOnce(
          account({ connection_status: WHATSAPP_CONNECTION_STATUS.DISCONNECTED }),
        )
        .mockResolvedValueOnce(null);
      accounts.find.mockResolvedValueOnce([account({ id: 'tenant-default' })]);

      expect((await resolver.forBranch(TENANT, 'b-1')).id).toBe('tenant-default');
    });

    it('throws when every account is disconnected', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ connection_status: WHATSAPP_CONNECTION_STATUS.DISCONNECTED }),
      ]);

      await expect(resolver.forTenant(TENANT)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('tells the clinic to reconnect, without exposing provider internals', async () => {
      accounts.findOne.mockResolvedValueOnce(
        account({ connection_status: WHATSAPP_CONNECTION_STATUS.REVOKED }),
      );

      await expect(resolver.byId(TENANT, 'acc-1')).rejects.toThrow(/reauthorize/i);
    });
  });

  describe('usableAccounts (shared with the eligible-accounts endpoint)', () => {
    it('returns only accounts that can actually send', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ id: 'live' }),
        account({ id: 'inactive', is_active: false }),
        account({ id: 'disconnected', connection_status: WHATSAPP_CONNECTION_STATUS.DISCONNECTED }),
        account({ id: 'expired', token_expires_at: new Date(Date.now() - 1000) }),
        account({ id: 'no-token', access_token: undefined }),
      ]);

      const usable = await resolver.usableAccounts(TENANT);

      // The campaign picker reads this, so it must agree with the sender exactly.
      expect(usable.map((a) => a.id)).toEqual(['live']);
    });
  });

  describe('no shared platform number (Tech Provider model)', () => {
    it('throws when the tenant has no connected account — never falls back to a shared number', async () => {
      accounts.findOne.mockResolvedValue(null);
      accounts.find.mockResolvedValue([]);

      // The old env-level PLATFORM_ENV fallback would have silently sent this
      // clinic's message from a number shared across all clinics.
      await expect(resolver.forBranch(TENANT, 'b-1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      await expect(resolver.forTenant(TENANT)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('explains how to fix it rather than failing opaquely', async () => {
      accounts.find.mockResolvedValueOnce([]);
      await expect(resolver.forTenant(TENANT)).rejects.toThrow(/no connected WhatsApp number/i);
    });

    it('throws when every candidate account has an expired token', async () => {
      accounts.find.mockResolvedValueOnce([
        account({ token_expires_at: new Date(Date.now() - 1000) }),
      ]);
      await expect(resolver.forTenant(TENANT)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});

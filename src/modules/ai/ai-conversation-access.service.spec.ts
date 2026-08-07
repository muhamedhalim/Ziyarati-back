import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AiConversationAccessService } from './ai-conversation-access.service';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * F-1 — the guest-ownership boundary.
 *
 * Every anonymous visitor is authenticated into the SAME discovery tenant, so
 * `tenant = { id: tenantId }` groups all of them together rather than
 * separating them. These tests pin the extra `guestSubject` comparison that
 * makes "my conversation" mean something for a guest, and pin the fail-closed
 * and no-oracle properties the fix depends on.
 */
const DISCOVERY_TENANT = 'guest-discovery-tenant';
const CLINIC_TENANT = 'clinic-tenant';

function guest(id: string, tenantId = DISCOVERY_TENANT): AuthenticatedUser {
  return { id, tenantId, email: null, roles: [], permissions: [], guest: true };
}

function staff(id: string, tenantId = CLINIC_TENANT): AuthenticatedUser {
  return {
    id,
    tenantId,
    email: `${id}@example.test`,
    roles: ['receptionist'],
    permissions: ['appointments.read'],
  };
}

describe('AiConversationAccessService', () => {
  let service: AiConversationAccessService;
  let conversations: MockRepository;

  beforeEach(async () => {
    conversations = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AiConversationAccessService,
        { provide: getRepositoryToken(AiConversation), useValue: conversations },
      ],
    }).compile();
    service = moduleRef.get(AiConversationAccessService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('guest principals', () => {
    it('allows the guest whose subject created the conversation', async () => {
      const conv = { id: 'conv-1', session: { guestSubject: 'guest-a' } };
      conversations.findOne.mockResolvedValueOnce(conv);

      await expect(
        service.assertAccess(DISCOVERY_TENANT, 'conv-1', guest('guest-a')),
      ).resolves.toBe(conv);
    });

    it('[F-1] refuses a DIFFERENT guest in the same discovery tenant — the exact defect', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: 'conv-1',
        session: { guestSubject: 'guest-a' },
      });

      await expect(
        service.assertAccess(DISCOVERY_TENANT, 'conv-1', guest('guest-b')),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('fails closed when the conversation carries NO binding (never "unowned, therefore allowed")', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: 'conv-1', session: {} });

      await expect(
        service.assertAccess(DISCOVERY_TENANT, 'conv-1', guest('guest-a')),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('fails closed when the session is null (pre-binding conversations)', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: 'conv-1', session: null });

      await expect(
        service.assertAccess(DISCOVERY_TENANT, 'conv-1', guest('guest-a')),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('is not an existence oracle — unknown id and not-yours raise the identical error', async () => {
      conversations.findOne.mockResolvedValueOnce(null);
      const unknown = await service
        .assertAccess(DISCOVERY_TENANT, 'no-such-conv', guest('guest-a'))
        .catch((e) => e);

      conversations.findOne.mockResolvedValueOnce({
        id: 'conv-1',
        session: { guestSubject: 'guest-a' },
      });
      const notMine = await service
        .assertAccess(DISCOVERY_TENANT, 'conv-1', guest('guest-b'))
        .catch((e) => e);

      expect(notMine.code).toBe(unknown.code);
      expect(notMine.message).toBe(unknown.message);
    });
  });

  describe('non-guest principals', () => {
    it('allows a staff principal on tenant ownership alone (no guestSubject involved)', async () => {
      const conv = { id: 'conv-1', session: { guestSubject: 'someone-else' } };
      conversations.findOne.mockResolvedValueOnce(conv);

      await expect(
        service.assertAccess(CLINIC_TENANT, 'conv-1', staff('user-1')),
      ).resolves.toBe(conv);
    });

    it('scopes the lookup by tenant, so another tenant\'s conversation is simply not found', async () => {
      conversations.findOne.mockResolvedValueOnce(null);

      await expect(
        service.assertAccess(CLINIC_TENANT, 'conv-of-other-clinic', staff('user-1')),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

      expect(conversations.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv-of-other-clinic', tenant: { id: CLINIC_TENANT } },
        }),
      );
    });

    it('loads the same relations AiConversationService.findOne returns (drop-in replacement)', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: 'conv-1', session: {} });
      await service.assertAccess(CLINIC_TENANT, 'conv-1', staff('user-1'));

      expect(conversations.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ relations: { agent: true, conversation: true } }),
      );
    });
  });

  describe('argument guards', () => {
    it.each([
      ['missing tenant', '', 'conv-1'],
      ['missing conversation id', CLINIC_TENANT, ''],
    ])('rejects on %s without querying', async (_label, tenantId, convId) => {
      await expect(
        service.assertAccess(tenantId, convId, staff('user-1')),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(conversations.findOne).not.toHaveBeenCalled();
    });
  });

  describe('canAccess', () => {
    it('returns true instead of throwing, for socket handlers', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: 'conv-1',
        session: { guestSubject: 'guest-a' },
      });
      await expect(
        service.canAccess(DISCOVERY_TENANT, 'conv-1', guest('guest-a')),
      ).resolves.toBe(true);
    });

    it('returns false instead of throwing, for socket handlers', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: 'conv-1',
        session: { guestSubject: 'guest-a' },
      });
      await expect(
        service.canAccess(DISCOVERY_TENANT, 'conv-1', guest('guest-b')),
      ).resolves.toBe(false);
    });
  });
});

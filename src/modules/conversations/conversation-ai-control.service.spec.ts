import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConversationAiControlService } from './conversation-ai-control.service';
import { Conversation } from '../../entities/Conversations/Conversation';
import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { AppError, ErrorCode } from '../../common/errors';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';
const CONV = 'c1';

const row = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  owner_type: 'AI',
  ai_mode: 'DEFAULT',
  ai_paused_until: null,
  ai_mode_changed_at: null,
  ai_mode_changed_by: null,
  customer: { id: 'cust-1' },
  ...over,
});

describe('ConversationAiControlService', () => {
  let service: ConversationAiControlService;
  let repo: MockRepository;
  let qb: ReturnType<typeof createMockQueryBuilder>;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    repo = createMockRepository();
    qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: 1 });
    repo.createQueryBuilder.mockReturnValue(qb);
    repo.findOne.mockResolvedValue(row());
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationAiControlService,
        { provide: getRepositoryToken(Conversation), useValue: repo },
        { provide: ActivityAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(ConversationAiControlService);
  });

  describe('getStatus', () => {
    it('reads the conversation inside the caller’s tenant only', async () => {
      await service.getStatus(TENANT, CONV);

      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONV, tenant: { id: TENANT } },
        }),
      );
    });

    it('answers 404 for a conversation of another clinic — indistinguishable from a missing one', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.getStatus(TENANT, 'foreign')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('reports the default state, the owner and the patient', async () => {
      await expect(service.getStatus(TENANT, CONV)).resolves.toEqual({
        conversationId: CONV,
        mode: 'DEFAULT',
        pausedUntil: null,
        changedAt: null,
        changedBy: null,
        ownerType: 'AI',
        customerId: 'cust-1',
      });
    });

    it('reports who changed the mode and when', async () => {
      const at = new Date('2030-01-01T10:00:00Z');
      repo.findOne.mockResolvedValue(
        row({
          ai_mode: 'DISABLED',
          ai_mode_changed_at: at,
          ai_mode_changed_by: { id: 'u9', full_name: 'Dr Sara' },
        }),
      );

      await expect(service.getStatus(TENANT, CONV)).resolves.toMatchObject({
        mode: 'DISABLED',
        changedAt: at,
        changedBy: { id: 'u9', name: 'Dr Sara' },
      });
    });

    it('reports an automatic-takeover deadline only while it is in the future', async () => {
      const future = new Date(Date.now() + 5 * 60_000);
      repo.findOne.mockResolvedValue(row({ ai_paused_until: future }));
      expect((await service.getStatus(TENANT, CONV)).pausedUntil).toEqual(
        future,
      );

      repo.findOne.mockResolvedValue(
        row({ ai_paused_until: new Date(Date.now() - 5 * 60_000) }),
      );
      expect((await service.getStatus(TENANT, CONV)).pausedUntil).toBeNull();
    });
  });

  describe('pause', () => {
    it('sets DISABLED with one tenant-scoped UPDATE, stamping who and when', async () => {
      repo.findOne
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ ai_mode: 'DISABLED' }));

      const status = await service.pause(TENANT, USER, CONV);

      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          ai_mode: 'DISABLED',
          ai_mode_changed_by: { id: USER },
          ai_mode_changed_at: expect.any(Date),
        }),
      );
      expect(qb.where).toHaveBeenCalledWith('id = :id', { id: CONV });
      expect(qb.andWhere).toHaveBeenCalledWith('"tenantId" = :tenantId', {
        tenantId: TENANT,
      });
      expect(status.mode).toBe('DISABLED');
    });

    it('does not touch ownership, assignment or messages — it only records the staff intent', async () => {
      await service.pause(TENANT, USER, CONV);

      const set = qb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(set).sort()).toEqual(
        ['ai_mode', 'ai_mode_changed_at', 'ai_mode_changed_by'].sort(),
      );
    });

    it('is audited with the acting user, never the request body', async () => {
      await service.pause(TENANT, USER, CONV);

      expect(audit.record).toHaveBeenCalledWith({
        tenantId: TENANT,
        actorUserId: USER,
        action: 'conversation.ai_paused',
        entityType: 'conversation',
        entityId: CONV,
        before: { ai_mode: 'DEFAULT' },
        after: { ai_mode: 'DISABLED' },
      });
    });

    it('is idempotent: pausing a paused conversation writes and audits nothing', async () => {
      repo.findOne.mockResolvedValue(row({ ai_mode: 'DISABLED' }));

      await service.pause(TENANT, USER, CONV);

      expect(qb.execute).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s — and writes nothing — for a conversation of another clinic', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.pause(TENANT, USER, 'foreign'),
      ).rejects.toBeInstanceOf(AppError);
      expect(qb.execute).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('resume', () => {
    it('returns to DEFAULT and ends any automatic-takeover window, in the same UPDATE', async () => {
      repo.findOne
        .mockResolvedValueOnce(row({ ai_mode: 'DISABLED' }))
        .mockResolvedValueOnce(row());

      await service.resume(TENANT, USER, CONV);

      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          ai_mode: 'DEFAULT',
          ai_paused_until: null,
          ai_mode_changed_by: { id: USER },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation.ai_resumed',
          before: { ai_mode: 'DISABLED', takeover_active: false },
          after: { ai_mode: 'DEFAULT' },
        }),
      );
    });

    it('can end a takeover window on a conversation whose mode is already DEFAULT', async () => {
      repo.findOne.mockResolvedValue(
        row({ ai_paused_until: new Date(Date.now() + 5 * 60_000) }),
      );

      await service.resume(TENANT, USER, CONV);

      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          before: { ai_mode: 'DEFAULT', takeover_active: true },
        }),
      );
    });

    it('refuses with 409 while a person owns the conversation — that is released with "Return to AI"', async () => {
      repo.findOne.mockResolvedValue(
        row({ ai_mode: 'DISABLED', owner_type: 'HUMAN' }),
      );

      await expect(service.resume(TENANT, USER, CONV)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(qb.execute).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses with 409 when a handover starts between the read and the write', async () => {
      repo.findOne.mockResolvedValue(row({ ai_mode: 'DISABLED' }));
      qb.execute.mockResolvedValue({ affected: 0 }); // owner_type flipped to HUMAN

      await expect(service.resume(TENANT, USER, CONV)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('owner_type <> :human', {
        human: 'HUMAN',
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('is idempotent: resuming a conversation with nothing to resume writes and audits nothing', async () => {
      await service.resume(TENANT, USER, CONV);

      expect(qb.execute).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s for a conversation of another clinic', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.resume(TENANT, USER, 'foreign'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});

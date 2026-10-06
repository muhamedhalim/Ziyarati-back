import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConversationAiTakeoverService } from './conversation-ai-takeover.service';
import { Conversation } from '../../entities/Conversations/Conversation';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CONV = 'c1';
const NOW = new Date('2030-01-01T10:00:00.000Z');

describe('ConversationAiTakeoverService.stampStaffReply', () => {
  let service: ConversationAiTakeoverService;
  let conversations: MockRepository;
  let settings: MockRepository;
  let qb: ReturnType<typeof createMockQueryBuilder>;

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(NOW);
    conversations = createMockRepository();
    qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: 1 });
    conversations.createQueryBuilder.mockReturnValue(qb);
    settings = createMockRepository();
    settings.findOne.mockResolvedValue({
      id: 'ts',
      ai_human_takeover_minutes: 30,
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationAiTakeoverService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        { provide: getRepositoryToken(TenantSetting), useValue: settings },
      ],
    }).compile();
    service = moduleRef.get(ConversationAiTakeoverService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('silences the AI until now + the clinic’s configured minutes, and returns that deadline', async () => {
    const until = await service.stampStaffReply(TENANT, CONV);

    const expected = new Date(NOW.getTime() + 30 * 60_000);
    expect(until).toEqual(expected);
    expect(qb.set).toHaveBeenCalledWith({ ai_paused_until: expected });
  });

  it('does nothing — not even a write — when automatic takeover is off (0 minutes)', async () => {
    settings.findOne.mockResolvedValue({
      id: 'ts',
      ai_human_takeover_minutes: 0,
    });

    await expect(service.stampStaffReply(TENANT, CONV)).resolves.toBeNull();

    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('treats a clinic with no settings row as off — today’s behaviour', async () => {
    settings.findOne.mockResolvedValue(null);

    await expect(service.stampStaffReply(TENANT, CONV)).resolves.toBeNull();
    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('reads the window for THIS clinic', async () => {
    await service.stampStaffReply(TENANT, CONV);

    expect(settings.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant: { id: TENANT } } }),
    );
  });

  it('is one tenant-scoped UPDATE of the AI deadline alone — never a read-modify-save of the conversation', async () => {
    await service.stampStaffReply(TENANT, CONV);

    expect(qb.where).toHaveBeenCalledWith('id = :id', { id: CONV });
    expect(qb.andWhere).toHaveBeenCalledWith('"tenantId" = :tenantId', {
      tenantId: TENANT,
    });
    const set = qb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(set)).toEqual(['ai_paused_until']);
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('only ever moves the deadline LATER — a reply never shortens a longer window', async () => {
    await service.stampStaffReply(TENANT, CONV);

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(ai_paused_until IS NULL OR ai_paused_until < :until)',
      { until: new Date(NOW.getTime() + 30 * 60_000) },
    );
  });

  it('a second reply later extends the window from that later moment', async () => {
    await service.stampStaffReply(TENANT, CONV);
    jest.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    const second = await service.stampStaffReply(TENANT, CONV);

    expect(second).toEqual(new Date(NOW.getTime() + 40 * 60_000));
  });

  it('is best-effort: a failed write is logged with ids only and does NOT fail the reply', async () => {
    qb.execute.mockRejectedValue(new Error('db down'));
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(service.stampStaffReply(TENANT, CONV)).resolves.toBeNull();

    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('AI_TAKEOVER_STAMP_FAILED');
    expect(logged).toContain(`conversation=${CONV}`);
  });

  it('is best-effort when the setting cannot be read either', async () => {
    settings.findOne.mockRejectedValue(new Error('db down'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.stampStaffReply(TENANT, CONV)).resolves.toBeNull();
    expect(qb.execute).not.toHaveBeenCalled();
  });
});

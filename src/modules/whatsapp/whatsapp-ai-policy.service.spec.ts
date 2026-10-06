import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappAiPolicyService } from './whatsapp-ai-policy.service';
import { AI_POLICY_REASON } from './whatsapp-ai-policy.constants';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { Conversation } from '../../entities/Conversations/Conversation';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import {
  AccessSource,
  QuotaPolicy,
} from '../subscription-billing/tenant-access-decision';
import { MetricsService } from '../../metrics/metrics.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const SUBJECT = { conversationId: 'conv-1', aiConversationId: 'ai-1' };

describe('WhatsappAiPolicyService', () => {
  let policy: WhatsappAiPolicyService;
  let tenantSettings: MockRepository;
  let conversations: MockRepository;
  let aiConversations: MockRepository;
  let access: { resolve: jest.Mock; shouldBlock: jest.Mock };
  let metrics: { recordWhatsappAiDecision: jest.Mock };

  const granted = (key: FeatureKey | null) => ({
    allowed: true,
    tenantId: TENANT,
    featureKey: key,
    source: AccessSource.FEATURE_OVERRIDE,
    quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
  });
  const refused = (key: FeatureKey | null) => ({
    allowed: false,
    tenantId: TENANT,
    featureKey: key,
    source: AccessSource.DENIED,
    quotaPolicy: QuotaPolicy.BLOCKED,
  });

  beforeEach(async () => {
    tenantSettings = createMockRepository();
    tenantSettings.findOne.mockResolvedValue({ id: 'ts', bot_enabled: true });
    conversations = createMockRepository();
    conversations.findOne.mockResolvedValue({ id: 'conv-1', owner_type: 'AI' });
    aiConversations = createMockRepository();
    aiConversations.findOne.mockResolvedValue({ id: 'ai-1', status: 'ACTIVE' });
    access = {
      resolve: jest.fn(async (_t: string, key: FeatureKey | null) =>
        granted(key),
      ),
      shouldBlock: jest.fn().mockReturnValue(true),
    };
    metrics = { recordWhatsappAiDecision: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappAiPolicyService,
        {
          provide: getRepositoryToken(TenantSetting),
          useValue: tenantSettings,
        },
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        {
          provide: getRepositoryToken(AiConversation),
          useValue: aiConversations,
        },
        { provide: AccessControlService, useValue: access },
        { provide: MetricsService, useValue: metrics },
        { provide: TenantContextService, useValue: new TenantContextService() },
      ],
    }).compile();
    policy = moduleRef.get(WhatsappAiPolicyService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('answers', () => {
    it('when the clinic is entitled, has the assistant on, and nobody has taken over', async () => {
      await expect(policy.evaluate(TENANT, SUBJECT, 'pre_ai')).resolves.toEqual(
        {
          allowed: true,
        },
      );
    });

    it('for a clinic with no settings row yet — the column default is on', async () => {
      tenantSettings.findOne.mockResolvedValue(null);

      await expect(policy.evaluate(TENANT, SUBJECT, 'pre_ai')).resolves.toEqual(
        {
          allowed: true,
        },
      );
    });

    it('when the conversation is owned by the AI and the AI session is ACTIVE', async () => {
      conversations.findOne.mockResolvedValue({
        id: 'conv-1',
        owner_type: 'AI',
      });
      aiConversations.findOne.mockResolvedValue({
        id: 'ai-1',
        status: 'ACTIVE',
      });

      await expect(
        policy.evaluate(TENANT, SUBJECT, 'pre_send'),
      ).resolves.toEqual({
        allowed: true,
      });
    });

    it('when nothing is known about the thread — only the clinic-wide rules apply', async () => {
      await expect(policy.evaluate(TENANT, {}, 'pre_ai')).resolves.toEqual({
        allowed: true,
      });
      expect(conversations.findOne).not.toHaveBeenCalled();
      expect(aiConversations.findOne).not.toHaveBeenCalled();
    });
  });

  describe('refuses', () => {
    it('with CLINIC_AI_DISABLED when the clinic switched the assistant off', async () => {
      tenantSettings.findOne.mockResolvedValue({
        id: 'ts',
        bot_enabled: false,
      });

      await expect(policy.evaluate(TENANT, SUBJECT, 'pre_ai')).resolves.toEqual(
        {
          allowed: false,
          reason: AI_POLICY_REASON.CLINIC_AI_DISABLED,
        },
      );
    });

    it.each([
      [
        'the conversation is owned by a person',
        { owner_type: 'HUMAN' },
        { status: 'ACTIVE' },
      ],
      [
        'the AI session is HANDED_OVER',
        { owner_type: 'AI' },
        { status: 'HANDED_OVER' },
      ],
      [
        'both say a person owns it',
        { owner_type: 'HUMAN' },
        { status: 'HANDED_OVER' },
      ],
    ])('with HUMAN_TAKEOVER when %s', async (_name, conv, ai) => {
      conversations.findOne.mockResolvedValue({ id: 'conv-1', ...conv });
      aiConversations.findOne.mockResolvedValue({ id: 'ai-1', ...ai });

      await expect(policy.evaluate(TENANT, SUBJECT, 'pre_ai')).resolves.toEqual(
        {
          allowed: false,
          reason: AI_POLICY_REASON.HUMAN_TAKEOVER,
        },
      );
    });

    it.each([FeatureKey.AI_ASSISTANT, FeatureKey.WHATSAPP])(
      'with FEATURE_DISABLED when "%s" is not granted but the clinic still has platform access',
      async (deniedKey) => {
        access.resolve.mockImplementation(
          async (_t: string, key: FeatureKey | null) =>
            key === deniedKey ? refused(key) : granted(key),
        );

        await expect(
          policy.evaluate(TENANT, SUBJECT, 'pre_ai'),
        ).resolves.toEqual({
          allowed: false,
          reason: AI_POLICY_REASON.FEATURE_DISABLED,
        });
      },
    );

    it('with SUBSCRIPTION_DISABLED when the clinic has no platform access at all', async () => {
      access.resolve.mockImplementation(
        async (_t: string, key: FeatureKey | null) => refused(key),
      );

      await expect(policy.evaluate(TENANT, SUBJECT, 'pre_ai')).resolves.toEqual(
        {
          allowed: false,
          reason: AI_POLICY_REASON.SUBSCRIPTION_DISABLED,
        },
      );
      // The split is made with the authority's own tenant-wide question.
      expect(access.resolve).toHaveBeenCalledWith(TENANT, null);
    });

    it('never lets a clinic setting widen what the plan allows — an enabled clinic without entitlement is refused', async () => {
      tenantSettings.findOne.mockResolvedValue({ id: 'ts', bot_enabled: true });
      access.resolve.mockImplementation(
        async (_t: string, key: FeatureKey | null) =>
          key === FeatureKey.AI_ASSISTANT ? refused(key) : granted(key),
      );

      const decision = await policy.evaluate(TENANT, SUBJECT, 'pre_ai');

      expect(decision.allowed).toBe(false);
    });
  });

  describe('precedence — the first refusal in the documented order is the reported reason', () => {
    it('entitlement outranks the clinic switch and a takeover', async () => {
      access.resolve.mockImplementation(
        async (_t: string, key: FeatureKey | null) =>
          key === FeatureKey.AI_ASSISTANT ? refused(key) : granted(key),
      );
      tenantSettings.findOne.mockResolvedValue({
        id: 'ts',
        bot_enabled: false,
      });
      conversations.findOne.mockResolvedValue({
        id: 'conv-1',
        owner_type: 'HUMAN',
      });

      await expect(
        policy.evaluate(TENANT, SUBJECT, 'pre_ai'),
      ).resolves.toMatchObject({
        reason: AI_POLICY_REASON.FEATURE_DISABLED,
      });
      // …and nothing further was read once it was refused.
      expect(tenantSettings.findOne).not.toHaveBeenCalled();
      expect(conversations.findOne).not.toHaveBeenCalled();
    });

    it('the clinic switch outranks a takeover', async () => {
      tenantSettings.findOne.mockResolvedValue({
        id: 'ts',
        bot_enabled: false,
      });
      conversations.findOne.mockResolvedValue({
        id: 'conv-1',
        owner_type: 'HUMAN',
      });

      await expect(
        policy.evaluate(TENANT, SUBJECT, 'pre_ai'),
      ).resolves.toMatchObject({
        reason: AI_POLICY_REASON.CLINIC_AI_DISABLED,
      });
    });
  });

  describe('ACCESS_POLICY_MODE=shadow', () => {
    it('records the denial but does not enforce it, exactly as at every other enforcement point', async () => {
      access.resolve.mockImplementation(
        async (_t: string, key: FeatureKey | null) => refused(key),
      );
      access.shouldBlock.mockReturnValue(false);

      await expect(policy.evaluate(TENANT, SUBJECT, 'pre_ai')).resolves.toEqual(
        {
          allowed: true,
        },
      );
      expect(access.shouldBlock).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: false }),
        { surface: 'webhook', detail: 'whatsapp.inbound.aiReply' },
      );
    });
  });

  describe('scoping', () => {
    it("reads only THIS clinic's settings, conversation and AI session", async () => {
      await policy.evaluate(TENANT, SUBJECT, 'pre_ai');

      expect(tenantSettings.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenant: { id: TENANT } } }),
      );
      expect(conversations.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv-1', tenant: { id: TENANT } },
        }),
      );
      expect(aiConversations.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ai-1', tenant: { id: TENANT } },
        }),
      );
    });

    it('a thread of another clinic is not found, so it can never make this clinic look handed over', async () => {
      // The tenant-scoped lookup returns nothing for a foreign id.
      conversations.findOne.mockResolvedValue(null);
      aiConversations.findOne.mockResolvedValue(null);

      await expect(
        policy.evaluate(
          TENANT,
          { conversationId: 'foreign', aiConversationId: 'foreign-ai' },
          'pre_ai',
        ),
      ).resolves.toEqual({ allowed: true });
    });
  });

  describe('freshness — a decision is only as good as the moment it is taken', () => {
    it('sees a takeover that happened between the pre-AI and pre-send checks', async () => {
      conversations.findOne
        .mockResolvedValueOnce({ id: 'conv-1', owner_type: 'AI' })
        .mockResolvedValueOnce({ id: 'conv-1', owner_type: 'HUMAN' });

      const before = await policy.evaluate(TENANT, SUBJECT, 'pre_ai');
      const after = await policy.evaluate(TENANT, SUBJECT, 'pre_send');

      expect(before.allowed).toBe(true);
      expect(after).toEqual({
        allowed: false,
        reason: AI_POLICY_REASON.HUMAN_TAKEOVER,
      });
      expect(conversations.findOne).toHaveBeenCalledTimes(2);
    });

    it('sees the clinic switching the assistant off mid-turn', async () => {
      tenantSettings.findOne
        .mockResolvedValueOnce({ id: 'ts', bot_enabled: true })
        .mockResolvedValueOnce({ id: 'ts', bot_enabled: false });

      expect((await policy.evaluate(TENANT, SUBJECT, 'pre_ai')).allowed).toBe(
        true,
      );
      expect(await policy.evaluate(TENANT, SUBJECT, 'pre_send')).toMatchObject({
        allowed: false,
        reason: AI_POLICY_REASON.CLINIC_AI_DISABLED,
      });
    });
  });

  describe('fails CLOSED when an input cannot be read', () => {
    beforeEach(() =>
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
    );

    it.each([
      [
        'entitlement',
        () => access.resolve.mockRejectedValue(new Error('db down')),
      ],
      [
        'the clinic switch',
        () => tenantSettings.findOne.mockRejectedValue(new Error('db down')),
      ],
      [
        'the conversation',
        () => conversations.findOne.mockRejectedValue(new Error('db down')),
      ],
      [
        'the AI session',
        () => aiConversations.findOne.mockRejectedValue(new Error('db down')),
      ],
    ])('when %s cannot be read', async (_name, breakIt) => {
      breakIt();

      await expect(policy.evaluate(TENANT, SUBJECT, 'pre_ai')).resolves.toEqual(
        {
          allowed: false,
          reason: AI_POLICY_REASON.POLICY_READ_FAILED,
        },
      );
    });

    it('logs the failure at ERROR level and does not throw', async () => {
      tenantSettings.findOne.mockRejectedValue(new Error('db down'));
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      await policy.evaluate(TENANT, SUBJECT, 'pre_ai');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('fail closed'),
      );
    });
  });

  describe('observability', () => {
    it('logs one WHATSAPP_AI_DECISION line per refusal — reason, stage, tenant and conversation, nothing else', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      tenantSettings.findOne.mockResolvedValue({
        id: 'ts',
        bot_enabled: false,
      });

      await policy.evaluate(TENANT, SUBJECT, 'pre_send');

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toMatch(
        /WHATSAPP_AI_DECISION decision=SKIP reason=CLINIC_AI_DISABLED stage=pre_send tenant=t1 conversation=conv-1$/,
      );
    });

    it('writes a "-" when there is no conversation yet', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      tenantSettings.findOne.mockResolvedValue({
        id: 'ts',
        bot_enabled: false,
      });

      await policy.evaluate(TENANT, {}, 'pre_ai');

      expect(logSpy.mock.calls[0][0]).toContain('conversation=-');
    });

    it('does not log an allowed decision', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      await policy.evaluate(TENANT, SUBJECT, 'pre_ai');

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('counts every decision with a closed label set — never a tenant or a contact', async () => {
      tenantSettings.findOne
        .mockResolvedValueOnce({ id: 'ts', bot_enabled: true })
        .mockResolvedValueOnce({ id: 'ts', bot_enabled: false });
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await policy.evaluate(TENANT, SUBJECT, 'pre_ai');
      await policy.evaluate(TENANT, SUBJECT, 'pre_send');

      expect(metrics.recordWhatsappAiDecision).toHaveBeenNthCalledWith(
        1,
        'ALLOW',
        'ALLOWED',
        'pre_ai',
      );
      expect(metrics.recordWhatsappAiDecision).toHaveBeenNthCalledWith(
        2,
        'SKIP',
        'CLINIC_AI_DISABLED',
        'pre_send',
      );
    });

    it('never logs a phone number, a message, or a credential', async () => {
      const spies = (['debug', 'log', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
      tenantSettings.findOne.mockResolvedValueOnce({
        id: 'ts',
        bot_enabled: false,
      });
      conversations.findOne.mockRejectedValueOnce(new Error('boom'));

      await policy.evaluate(TENANT, SUBJECT, 'pre_ai');
      access.resolve.mockRejectedValueOnce(new Error('boom'));
      await policy.evaluate(TENANT, SUBJECT, 'pre_send');

      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => call.map(String).join(' '))
        .join('\n');
      // The only identifiers it may carry are the ones the caller passed.
      expect(logged).toMatch(/tenant=t1/);
      expect(logged).not.toMatch(/\d{9,}/); // no phone-number-shaped value
    });
  });
});

import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { ConversationAiControlController } from './conversation-ai-control.controller';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';

const base = {
  conversationId: 'conv-1',
  mode: 'DEFAULT',
  pausedUntil: null,
  changedAt: null,
  changedBy: null,
  ownerType: 'AI',
  customerId: 'cust-1',
};

describe('ConversationAiControlController', () => {
  const control = {
    getStatus: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
  };
  const policy = { explain: jest.fn() };
  const ctx = { requireTenantId: jest.fn().mockReturnValue('t1') };
  const controller = new ConversationAiControlController(
    control as never,
    policy as never,
    ctx as never,
  );

  beforeEach(() => {
    control.getStatus.mockResolvedValue(base);
    control.pause.mockResolvedValue({ ...base, mode: 'DISABLED' });
    control.resume.mockResolvedValue(base);
    policy.explain.mockResolvedValue({ allowed: true });
  });
  afterEach(() => jest.clearAllMocks());

  describe('status', () => {
    it('adds the live decision to the stored state', async () => {
      policy.explain.mockResolvedValue({
        allowed: false,
        reason: 'CONVERSATION_AI_DISABLED',
      });

      const view = await controller.status('conv-1');

      expect(view.effective).toEqual({
        allowed: false,
        reason: 'CONVERSATION_AI_DISABLED',
      });
      expect(view.mode).toBe('DEFAULT');
    });

    it('reports "allowed" with no reason', async () => {
      await expect(controller.status('conv-1')).resolves.toMatchObject({
        effective: { allowed: true, reason: null },
      });
    });

    it('asks the SAME policy the inbound path uses, for this conversation and patient, in the caller’s tenant', async () => {
      await controller.status('conv-1');

      expect(policy.explain).toHaveBeenCalledWith('t1', {
        conversationId: 'conv-1',
        customerId: 'cust-1',
      });
    });

    it('does not expose the internal patient id lookup key in the response', async () => {
      expect(await controller.status('conv-1')).not.toHaveProperty(
        'customerId',
      );
    });
  });

  describe('pause / resume', () => {
    it('pause: acts as the authenticated user in the authenticated tenant', async () => {
      const view = await controller.pause('conv-1', 'u1');

      expect(control.pause).toHaveBeenCalledWith('t1', 'u1', 'conv-1');
      expect(view.mode).toBe('DISABLED');
      expect(view.effective).toEqual({ allowed: true, reason: null });
    });

    it('resume: same, and the response says whether the AI will actually answer', async () => {
      policy.explain.mockResolvedValue({
        allowed: false,
        reason: 'PATIENT_AI_DISABLED',
      });

      const view = await controller.resume('conv-1', 'u1');

      expect(control.resume).toHaveBeenCalledWith('t1', 'u1', 'conv-1');
      expect(view.effective).toEqual({
        allowed: false,
        reason: 'PATIENT_AI_DISABLED',
      });
    });

    it('takes the tenant from the authenticated context, never from the request', async () => {
      await controller.pause('conv-1', 'u1');

      expect(ctx.requireTenantId).toHaveBeenCalled();
      expect(control.pause.mock.calls[0][0]).toBe('t1');
    });

    it('propagates a refusal (409 / 404) instead of swallowing it', async () => {
      control.resume.mockRejectedValue(new Error('CONFLICT'));

      await expect(controller.resume('conv-1', 'u1')).rejects.toThrow(
        'CONFLICT',
      );
      expect(policy.explain).not.toHaveBeenCalled();
    });
  });

  describe('routes and permissions', () => {
    const route = (name: keyof ConversationAiControlController) =>
      ConversationAiControlController.prototype[name] as never;

    it('lives under conversations/:id/…', () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, ConversationAiControlController),
      ).toBe('conversations');
      expect(Reflect.getMetadata(PATH_METADATA, route('status'))).toBe(
        ':id/ai-status',
      );
      expect(Reflect.getMetadata(PATH_METADATA, route('pause'))).toBe(
        ':id/ai/pause',
      );
      expect(Reflect.getMetadata(PATH_METADATA, route('resume'))).toBe(
        ':id/ai/resume',
      );
    });

    it('status is a GET behind conversations.read; pause and resume are POSTs behind ai.handover.manage', () => {
      expect(Reflect.getMetadata(METHOD_METADATA, route('status'))).toBe(
        RequestMethod.GET,
      );
      expect(Reflect.getMetadata(PERMISSIONS_KEY, route('status'))).toEqual([
        PERMISSION.CONVERSATIONS_READ,
      ]);
      for (const name of ['pause', 'resume'] as const) {
        expect(Reflect.getMetadata(METHOD_METADATA, route(name))).toBe(
          RequestMethod.POST,
        );
        expect(Reflect.getMetadata(PERMISSIONS_KEY, route(name))).toEqual([
          PERMISSION.AI_HANDOVER_MANAGE,
        ]);
      }
    });
  });
});

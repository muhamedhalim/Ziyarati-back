import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { StaffWhatsappReplyController } from './staff-whatsapp-reply.controller';
import {
  StaffWhatsappReplyDto,
  WHATSAPP_TEXT_MAX_LENGTH,
} from './dto/staff-whatsapp-reply.dto';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';

describe('StaffWhatsappReplyController', () => {
  const reply = { send: jest.fn().mockResolvedValue({ conversationId: 'c1' }) };
  const ctx = { requireTenantId: jest.fn().mockReturnValue('t1') };
  const controller = new StaffWhatsappReplyController(
    reply as never,
    ctx as never,
  );

  afterEach(() => jest.clearAllMocks());

  it('acts as the authenticated user in the authenticated tenant, never one from the request', async () => {
    await controller.send('c1', { content: 'Hello' }, 'u1');

    expect(reply.send).toHaveBeenCalledWith('t1', 'u1', 'c1', 'Hello');
    expect(ctx.requireTenantId).toHaveBeenCalled();
  });

  it('is POST conversations/:id/whatsapp-reply, behind BOTH messages.send and whatsapp.send', () => {
    const handler = StaffWhatsappReplyController.prototype.send;

    expect(
      Reflect.getMetadata(PATH_METADATA, StaffWhatsappReplyController),
    ).toBe('conversations');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      ':id/whatsapp-reply',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    // PermissionsGuard requires ALL of these.
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      PERMISSION.MESSAGES_SEND,
      PERMISSION.WHATSAPP_SEND,
    ]);
  });

  describe('StaffWhatsappReplyDto', () => {
    const errors = (payload: object) =>
      validate(plainToInstance(StaffWhatsappReplyDto, payload));

    it('accepts 1 to 4096 characters', async () => {
      expect(await errors({ content: 'x' })).toHaveLength(0);
      expect(
        await errors({ content: 'x'.repeat(WHATSAPP_TEXT_MAX_LENGTH) }),
      ).toHaveLength(0);
    });

    it.each([
      [{}],
      [{ content: '' }],
      [{ content: '   ' }],
      [{ content: 'x'.repeat(WHATSAPP_TEXT_MAX_LENGTH + 1) }],
      [{ content: 42 }],
      [{ content: null }],
    ])('rejects %j', async (payload) => {
      expect(await errors(payload)).not.toHaveLength(0);
    });

    it('trims the text it will send', () => {
      expect(
        plainToInstance(StaffWhatsappReplyDto, { content: '  hi  ' }).content,
      ).toBe('hi');
    });
  });
});

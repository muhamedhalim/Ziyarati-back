import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CustomerController } from './customer.controller';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerAiRepliesDto } from './dto/update-customer-ai-replies.dto';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';

describe('CustomerController — PATCH :id/ai-replies', () => {
  const aiReplies = { setDisabled: jest.fn().mockResolvedValue({ id: 'c1' }) };
  const ctx = { requireTenantId: jest.fn().mockReturnValue('t1') };
  const controller = new CustomerController(
    {} as never,
    ctx as never,
    {} as never,
    aiReplies as never,
  );

  afterEach(() => jest.clearAllMocks());

  it('acts as the authenticated user in the authenticated tenant', async () => {
    await controller.setAiReplies('c1', { disabled: true }, 'u1');

    expect(aiReplies.setDisabled).toHaveBeenCalledWith('t1', 'u1', 'c1', true);
  });

  it('is its own route, requiring crm.customers.manage — NOT the update_own permission a doctor holds', () => {
    const handler = CustomerController.prototype.setAiReplies;

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/ai-replies');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.PATCH,
    );
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      PERMISSION.CRM_CUSTOMERS_MANAGE,
    ]);
  });

  describe('the flag cannot be reached through any other customer route', () => {
    const rejectsUnknown = async (cls: new () => object, payload: object) =>
      (
        await validate(plainToInstance(cls, payload), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((e) => e.property);

    it.each([
      'ai_replies_disabled',
      'aiRepliesDisabled',
      'ai_replies_disabled_at',
    ])('the generic update refuses %s', async (field) => {
      expect(
        await rejectsUnknown(UpdateCustomerDto, { [field]: true }),
      ).toContain(field);
    });

    it('creating a customer cannot pre-set it either', async () => {
      expect(
        await rejectsUnknown(CreateCustomerDto, {
          name: 'x',
          ai_replies_disabled: true,
        }),
      ).toContain('ai_replies_disabled');
    });
  });

  describe('UpdateCustomerAiRepliesDto', () => {
    const errors = (payload: object) =>
      validate(plainToInstance(UpdateCustomerAiRepliesDto, payload));

    it('accepts a boolean', async () => {
      expect(await errors({ disabled: true })).toHaveLength(0);
      expect(await errors({ disabled: false })).toHaveLength(0);
    });

    it.each([{}, { disabled: 'yes' }, { disabled: 1 }, { disabled: null }])(
      'rejects %p',
      async (payload) => {
        expect(await errors(payload)).not.toHaveLength(0);
      },
    );
  });
});

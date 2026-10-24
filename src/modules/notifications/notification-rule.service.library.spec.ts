import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { NotificationRuleService } from './notification-rule.service';
import { NotificationRuleLibraryService } from './rule-library/rule-library.service';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { AppError, ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * The generic rule endpoints must not become a back door around the ready-made
 * rules' guard: switching one on is judged the same way however it is requested.
 */
describe('NotificationRuleService — ready-made rules', () => {
  let service: NotificationRuleService;
  let rules: MockRepository;
  let library: {
    enable: jest.Mock;
    disable: jest.Mock;
    assertCanEnable: jest.Mock;
  };

  const libraryRule = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    rule_key: 'reminder_24h',
    trigger_event: 'appointment.confirmed',
    anchor: 'BEFORE_APPOINTMENT_START',
    is_active: false,
    ...over,
  });
  const handMade = (over: Record<string, unknown> = {}) => ({
    id: 'r2',
    rule_key: null,
    trigger_event: 'appointment.created',
    anchor: 'AFTER_EVENT',
    is_active: false,
    ...over,
  });

  beforeEach(async () => {
    rules = createMockRepository();
    rules.save.mockImplementation((r: unknown) => Promise.resolve(r));
    const templates = createMockRepository();
    templates.exists.mockResolvedValue(true);
    library = {
      enable: jest.fn().mockResolvedValue(undefined),
      disable: jest.fn().mockResolvedValue(undefined),
      assertCanEnable: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationRuleService,
        { provide: getRepositoryToken(NotificationRule), useValue: rules },
        {
          provide: getRepositoryToken(NotificationTemplate),
          useValue: templates,
        },
        { provide: NotificationRuleLibraryService, useValue: library },
      ],
    }).compile();
    service = moduleRef.get(NotificationRuleService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('setActive (the enable/disable endpoints)', () => {
    it('sends a ready-made rule through the guarded, audited path, with the actor', async () => {
      rules.findOne.mockResolvedValue(libraryRule());
      await service.setActive(TENANT, 'r1', true, 'u1');
      expect(library.enable).toHaveBeenCalledWith(TENANT, 'r1', 'u1');
      // The flag is not flipped here behind the guard's back.
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('a refusal from the guard reaches the caller and nothing is saved', async () => {
      rules.findOne.mockResolvedValue(libraryRule());
      library.enable.mockRejectedValue(
        new AppError(ErrorCode.CONFLICT, { message: 'not ready' }),
      );
      await expect(
        service.setActive(TENANT, 'r1', true, 'u1'),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('disabling a ready-made rule is audited too', async () => {
      rules.findOne.mockResolvedValue(libraryRule({ is_active: true }));
      await service.setActive(TENANT, 'r1', false, 'u1');
      expect(library.disable).toHaveBeenCalledWith(TENANT, 'r1', 'u1');
    });

    it('a hand-made rule keeps its old behaviour exactly (no guard, direct flag)', async () => {
      rules.findOne.mockResolvedValue(handMade());
      await service.setActive(TENANT, 'r2', true, 'u1');
      expect(library.enable).not.toHaveBeenCalled();
      expect(rules.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: true }),
      );
    });
  });

  describe('update (PATCH)', () => {
    it('runs the guard when it switches a ready-made rule on', async () => {
      rules.findOne.mockResolvedValue(libraryRule());
      await service.update(TENANT, 'r1', { isActive: true } as never);
      expect(library.assertCanEnable).toHaveBeenCalledTimes(1);
    });

    it('does not run the guard when the rule stays on, or an unrelated field changes', async () => {
      rules.findOne.mockResolvedValue(libraryRule({ is_active: true }));
      await service.update(TENANT, 'r1', { isActive: true } as never);
      rules.findOne.mockResolvedValue(libraryRule());
      await service.update(TENANT, 'r1', { delayMinutes: 600 } as never);
      expect(library.assertCanEnable).not.toHaveBeenCalled();
    });

    it('a guard refusal stops the save', async () => {
      rules.findOne.mockResolvedValue(libraryRule());
      library.assertCanEnable.mockRejectedValue(
        new AppError(ErrorCode.CONFLICT, { message: 'nope' }),
      );
      await expect(
        service.update(TENANT, 'r1', { isActive: true } as never),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('will not rewrite the trigger or anchor of a ready-made rule', async () => {
      rules.findOne.mockResolvedValue(libraryRule());
      await expect(
        service.update(TENANT, 'r1', {
          triggerEvent: 'appointment.cancelled',
        } as never),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      await expect(
        service.update(TENANT, 'r1', { anchor: 'AFTER_EVENT' } as never),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('re-sending the SAME trigger is not a change', async () => {
      rules.findOne.mockResolvedValue(libraryRule());
      await expect(
        service.update(TENANT, 'r1', {
          triggerEvent: 'appointment.confirmed',
          anchor: 'BEFORE_APPOINTMENT_START',
        } as never),
      ).resolves.toBeDefined();
    });

    it('a hand-made rule can still change its trigger', async () => {
      rules.findOne.mockResolvedValue(handMade());
      await service.update(TENANT, 'r2', {
        triggerEvent: 'appointment.cancelled',
      } as never);
      expect(rules.save).toHaveBeenCalledWith(
        expect.objectContaining({ trigger_event: 'appointment.cancelled' }),
      );
    });
  });
});

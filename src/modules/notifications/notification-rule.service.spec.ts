import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { NotificationRuleService } from './notification-rule.service';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('NotificationRuleService', () => {
  let service: NotificationRuleService;
  let rules: MockRepository;
  let templates: MockRepository;

  beforeEach(async () => {
    rules = createMockRepository();
    templates = createMockRepository();
    templates.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationRuleService,
        { provide: getRepositoryToken(NotificationRule), useValue: rules },
        { provide: getRepositoryToken(NotificationTemplate), useValue: templates },
      ],
    }).compile();
    service = moduleRef.get(NotificationRuleService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a rule after validating the template', async () => {
    rules.save.mockResolvedValueOnce({ id: 'r1' });
    await service.create(TENANT, { triggerEvent: 'appointment.created', templateId: 'tpl1' } as any);
    expect(templates.exists).toHaveBeenCalled();
  });

  it('rejects a template not in the tenant with 422', async () => {
    templates.exists.mockResolvedValueOnce(false);
    await expect(
      service.create(TENANT, { triggerEvent: 'x', templateId: 'bad' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });

  it('findOne throws for an unknown rule', async () => {
    rules.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('updates, toggles active, and removes', async () => {
    rules.findOne.mockResolvedValue({ id: 'r1', is_active: true });
    rules.save.mockImplementation(async (r: any) => r);
    await service.update(TENANT, 'r1', { delayMinutes: 30 } as any);
    expect(rules.save).toHaveBeenCalledWith(expect.objectContaining({ delay_minutes: 30 }));
    await service.setActive(TENANT, 'r1', false);
    expect(rules.save).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    await service.remove(TENANT, 'r1');
    expect(rules.delete).toHaveBeenCalledWith({ id: 'r1' });
  });
});

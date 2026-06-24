import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { NotificationTemplateService } from './notification-template.service';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('NotificationTemplateService', () => {
  let service: NotificationTemplateService;
  let templates: MockRepository;
  let rules: MockRepository;
  let scheduled: MockRepository;

  beforeEach(async () => {
    templates = createMockRepository();
    rules = createMockRepository();
    scheduled = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationTemplateService,
        { provide: getRepositoryToken(NotificationTemplate), useValue: templates },
        { provide: getRepositoryToken(NotificationRule), useValue: rules },
        { provide: getRepositoryToken(ScheduledNotification), useValue: scheduled },
      ],
    }).compile();
    service = moduleRef.get(NotificationTemplateService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a template', async () => {
    templates.save.mockResolvedValueOnce({ id: 'tpl1' });
    await expect(service.create(TENANT, { name: 'Reminder', channel: 'WHATSAPP' } as any)).resolves.toEqual({ id: 'tpl1' });
  });

  it('findOne throws for an unknown template', async () => {
    templates.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('updates and toggles active', async () => {
    templates.findOne.mockResolvedValue({ id: 'tpl1', is_active: true });
    templates.save.mockImplementation(async (t: any) => t);
    await service.update(TENANT, 'tpl1', { name: 'New' } as any);
    expect(templates.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }));
    await service.setActive(TENANT, 'tpl1', false);
    expect(templates.save).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
  });

  it('blocks deleting a template that is still referenced', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1' });
    rules.count.mockResolvedValueOnce(1);
    scheduled.count.mockResolvedValueOnce(0);
    await expect(service.remove(TENANT, 'tpl1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('deletes an unreferenced template', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1' });
    rules.count.mockResolvedValueOnce(0);
    scheduled.count.mockResolvedValueOnce(0);
    await service.remove(TENANT, 'tpl1');
    expect(templates.delete).toHaveBeenCalledWith({ id: 'tpl1' });
  });
});

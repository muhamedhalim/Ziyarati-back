import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { CanActivate } from '@nestjs/common';
import request from 'supertest';

import { NotificationRuleController } from './notification-rule.controller';
import { NotificationRuleService } from './notification-rule.service';
import { NotificationRuleLibraryService } from './rule-library/rule-library.service';
import { WhatsappTemplateController } from '../whatsapp/whatsapp-template.controller';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import { WhatsappTemplateLibraryService } from '../whatsapp/template-library/template-library.service';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';

/**
 * `GET …/library` sits next to `GET …/:id` (a `ParseUUIDPipe` route). If a literal
 * segment is ever declared AFTER `:id`, Express hands `library` to `:id` and the
 * caller gets `Validation failed (uuid is expected)`. These go through the real
 * router (not a direct method call), so route ORDER is what is being tested.
 */
const TENANT = 'tenant-from-session';
const UUID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const allow: CanActivate = { canActivate: () => true };

describe('library routes are not captured by `:id`', () => {
  let app: INestApplication;
  const ruleLibrary = { list: jest.fn() };
  const rules = { findOne: jest.fn(), findAll: jest.fn() };
  const templateLibrary = { list: jest.fn() };
  const templates = { findOneView: jest.fn(), findAll: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationRuleController, WhatsappTemplateController],
      providers: [
        { provide: NotificationRuleService, useValue: rules },
        { provide: NotificationRuleLibraryService, useValue: ruleLibrary },
        { provide: WhatsappTemplateService, useValue: templates },
        { provide: WhatsappTemplateLibraryService, useValue: templateLibrary },
        { provide: WhatsappExecutionService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { requireTenantId: () => TENANT },
        },
      ],
    })
      .overrideGuard(PermissionsGuard)
      .useValue(allow)
      .overrideGuard(ActiveTenantGuard)
      .useValue(allow)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('GET /notification-rules/library reaches the library handler, scoped to the session tenant', async () => {
    ruleLibrary.list.mockResolvedValue([{ key: 'booking_confirmation' }]);
    const res = await request(app.getHttpServer()).get(
      '/notification-rules/library',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ key: 'booking_confirmation' }]);
    expect(ruleLibrary.list).toHaveBeenCalledWith(TENANT);
    expect(rules.findOne).not.toHaveBeenCalled();
  });

  it('GET /whatsapp/templates/library reaches the library handler, scoped to the session tenant', async () => {
    templateLibrary.list.mockResolvedValue([
      { key: 'appointment_reminder_24h' },
    ]);
    const res = await request(app.getHttpServer()).get(
      '/whatsapp/templates/library',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ key: 'appointment_reminder_24h' }]);
    expect(templateLibrary.list).toHaveBeenCalledWith(TENANT);
    expect(templates.findOneView).not.toHaveBeenCalled();
  });

  it('`:id` routes still take a uuid and still reject anything else with the uuid error', async () => {
    rules.findOne.mockResolvedValue({ id: UUID });
    templates.findOneView.mockResolvedValue({ id: UUID });

    expect(
      (await request(app.getHttpServer()).get(`/notification-rules/${UUID}`))
        .status,
    ).toBe(200);
    expect(
      (await request(app.getHttpServer()).get(`/whatsapp/templates/${UUID}`))
        .status,
    ).toBe(200);

    for (const path of [
      '/notification-rules/not-a-uuid',
      '/whatsapp/templates/not-a-uuid',
    ]) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('uuid');
    }
  });

  it('keeps its permission requirement (the guards, not the route shape, authorise it)', () => {
    const permsOf = (proto: object, name: string) =>
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        (proto as Record<string, object>)[name],
      );
    expect(
      permsOf(NotificationRuleController.prototype, 'libraryRules'),
    ).toEqual([PERMISSION.NOTIFICATION_RULES_READ]);
    expect(permsOf(WhatsappTemplateController.prototype, 'library')).toEqual([
      PERMISSION.WHATSAPP_TEMPLATES_READ,
    ]);
  });
});

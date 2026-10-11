import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { WhatsappAnalyticsController } from './whatsapp-analytics.controller';
import { WhatsappNotificationSummaryQueryDto } from './dto/whatsapp-notification-summary-query.dto';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';

describe('GET /whatsapp/analytics/summary', () => {
  const handler = WhatsappAnalyticsController.prototype.summary;

  it('requires whatsapp.analytics.read (enforced server-side, not just by the UI)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('summary');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // GET
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      PERMISSION.WHATSAPP_ANALYTICS_READ,
    ]);
  });

  it('takes the tenant from the authenticated context, never from the query', async () => {
    const summary = jest.fn().mockResolvedValue({ range: '30d' });
    const ctx = {
      requireTenantId: () => 'tenant-from-context',
      getTenant: () => ({
        name: 'Sunrise Clinic',
        default_timezone: 'Asia/Riyadh',
      }),
    };
    const controller = new WhatsappAnalyticsController(
      {} as never,
      { summary } as never,
      ctx as never,
    );

    // A hostile query string carrying a tenant id must have no effect.
    const query = Object.assign(new WhatsappNotificationSummaryQueryDto(), {
      range: '7d',
      tenantId: 'someone-elses-tenant',
    });
    const out = await controller.summary(query);

    expect(summary).toHaveBeenCalledWith(
      'tenant-from-context',
      '7d',
      'Asia/Riyadh',
    );
    expect(out.clinicName).toBe('Sunrise Clinic');
    expect(JSON.stringify(out)).not.toContain('tenant-from-context');
  });

  it('defaults to a 30-day window', async () => {
    const summary = jest.fn().mockResolvedValue({});
    const controller = new WhatsappAnalyticsController(
      {} as never,
      { summary } as never,
      { requireTenantId: () => 't', getTenant: () => null } as never,
    );
    await controller.summary(new WhatsappNotificationSummaryQueryDto());
    expect(summary).toHaveBeenCalledWith('t', '30d', undefined);
  });
});

describe('WhatsappNotificationSummaryQueryDto', () => {
  const check = (range: unknown) =>
    validate(plainToInstance(WhatsappNotificationSummaryQueryDto, { range }));

  it.each(['7d', '30d', '90d'])('accepts %s', async (range) => {
    expect(await check(range)).toHaveLength(0);
  });

  it.each(['1d', '365d', "30d'; DROP TABLE x;--", 30, ''])(
    'rejects %p (the window is a closed set, so queries stay bounded)',
    async (range) => {
      expect((await check(range)).length).toBeGreaterThan(0);
    },
  );

  it('accepts an omitted range', async () => {
    expect(
      await validate(plainToInstance(WhatsappNotificationSummaryQueryDto, {})),
    ).toHaveLength(0);
  });
});

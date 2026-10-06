import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { UpdateTenantSettingsDto } from './update-tenant-settings.dto';

describe('UpdateTenantSettingsDto — reminder lead-time whitelist (T011)', () => {
  it('accepts every value in the supported set', async () => {
    const dto = plainToInstance(UpdateTenantSettingsDto, {
      reminderLeadMinutes: [1440, 180, 60],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts an empty array (no reminders configured)', async () => {
    const dto = plainToInstance(UpdateTenantSettingsDto, {
      reminderLeadMinutes: [],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a free-form offset outside the supported set', async () => {
    const dto = plainToInstance(UpdateTenantSettingsDto, {
      reminderLeadMinutes: [45],
    });
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('reminderLeadMinutes');
  });

  it('rejects a mix of a supported and an unsupported value', async () => {
    const dto = plainToInstance(UpdateTenantSettingsDto, {
      reminderLeadMinutes: [1440, 45],
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('UpdateTenantSettingsDto — aiHumanTakeoverMinutes', () => {
  const check = (v: unknown) =>
    validate(
      plainToInstance(UpdateTenantSettingsDto, { aiHumanTakeoverMinutes: v }),
    );

  it.each([0, 1, 30, 1440])('accepts %p', async (v) => {
    expect(await check(v)).toHaveLength(0);
  });

  it('is optional', async () => {
    expect(
      await validate(plainToInstance(UpdateTenantSettingsDto, {})),
    ).toHaveLength(0);
  });

  it.each([-1, 1441, 1.5, '30', 'abc'])('rejects %p', async (v) => {
    const errors = await check(v);
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('aiHumanTakeoverMinutes');
  });
});

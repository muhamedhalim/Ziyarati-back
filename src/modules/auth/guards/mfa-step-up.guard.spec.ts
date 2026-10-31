import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';

import { AppError } from '../../../common/errors';
import { MFA_STEP_UP_HEADER, MfaStepUpGuard } from './mfa-step-up.guard';

describe('MfaStepUpGuard (PAY-012)', () => {
  const USER = {
    id: 'u1',
    tenantId: null,
    roles: ['super_admin'],
    permissions: [],
  };

  function build(opts: {
    flag?: string;
    enabled?: boolean;
    verify?: jest.Mock;
    mandatory?: boolean;
  }) {
    const mfa = {
      isEnabled: jest.fn().mockResolvedValue(opts.enabled ?? true),
      isMandatory: jest.fn().mockReturnValue(opts.mandatory ?? false),
      verify: opts.verify ?? jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = {
      get: jest.fn().mockReturnValue(mfa),
    } as unknown as ModuleRef;
    const config = {
      get: jest.fn().mockReturnValue(opts.flag),
    } as unknown as ConfigService;
    return { guard: new MfaStepUpGuard(moduleRef, config), mfa, moduleRef };
  }

  const ctx = (headers: Record<string, string> = {}, user: unknown = USER) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, headers }) }),
    }) as unknown as ExecutionContext;

  it('does nothing while MFA_STEP_UP_ENABLED is off (and never touches the MFA service)', async () => {
    const { guard, moduleRef } = build({ flag: undefined });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(moduleRef.get).not.toHaveBeenCalled();
  });

  it('lets a user with no enabled factor through (nothing to ask them for)', async () => {
    const { guard, mfa } = build({ flag: 'true', enabled: false });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  it('fails closed for a mandatory-MFA user who has no factor', async () => {
    const { guard, mfa } = build({
      flag: 'true',
      enabled: false,
      mandatory: true,
    });
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(AppError);
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  it('answers 403 with mfaStepUp=true when a user with a factor sends no code', async () => {
    const { guard } = build({ flag: 'true' });
    const err = await guard.canActivate(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).publicContext).toEqual({ mfaStepUp: true });
  });

  it('verifies a 6-digit header as a TOTP code', async () => {
    const { guard, mfa } = build({ flag: 'true' });
    await expect(
      guard.canActivate(ctx({ [MFA_STEP_UP_HEADER]: ' 123456 ' })),
    ).resolves.toBe(true);
    expect(mfa.verify).toHaveBeenCalledWith('u1', { code: '123456' });
  });

  it('treats any other value as a recovery code', async () => {
    const { guard, mfa } = build({ flag: 'true' });
    await guard.canActivate(ctx({ [MFA_STEP_UP_HEADER]: 'abcd-efgh' }));
    expect(mfa.verify).toHaveBeenCalledWith('u1', {
      recoveryCode: 'abcd-efgh',
    });
  });

  it('rejects when verification fails, so the route never runs', async () => {
    const verify = jest
      .fn()
      .mockRejectedValue(new Error('Invalid verification code.'));
    const { guard } = build({ flag: 'true', verify });
    await expect(
      guard.canActivate(ctx({ [MFA_STEP_UP_HEADER]: '000000' })),
    ).rejects.toThrow('Invalid verification code.');
  });

  it('refuses a request with no authenticated user when enabled', async () => {
    const { guard } = build({ flag: 'true' });
    await expect(guard.canActivate(ctx({}, undefined))).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

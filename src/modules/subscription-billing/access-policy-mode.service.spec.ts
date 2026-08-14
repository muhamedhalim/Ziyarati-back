import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import {
  ACCESS_POLICY_MODE,
  AccessPolicyModeService,
} from './access-policy-mode.service';
import { AccessSource, QuotaPolicy } from './tenant-access-decision';
import { FeatureKey } from './feature-registry';

const decision = (tenantId = 't1') => ({
  allowed: false,
  tenantId,
  featureKey: FeatureKey.WHATSAPP,
  source: AccessSource.DENIED,
  quotaPolicy: QuotaPolicy.BLOCKED,
  reason: 'Subscription is not active (status: CANCELLED)',
});

const build = (value?: string) =>
  new AccessPolicyModeService({
    get: jest.fn().mockReturnValue(value),
  } as unknown as ConfigService);

const SITE = { surface: 'http', detail: 'GET /campaigns' };

/**
 * The rollout switch (plan §18).
 *
 * The policy this codebase enforces is materially stricter than what production
 * has ever run — 128 controllers gained a capability annotation and the platform
 * is still in FREE billing mode, so none of it has met real traffic. Shadow mode
 * is the safety net that turns a hard cutover into a reviewable deny log, and
 * the thing it must never become is a way to accidentally disable authorization.
 */
describe('AccessPolicyModeService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('defaults to enforce when unset', () => {
    const service = build(undefined);
    expect(service.current).toBe(ACCESS_POLICY_MODE.ENFORCE);
    expect(service.shouldBlock(decision(), SITE)).toBe(true);
  });

  it('enters shadow mode on the exact value, case- and whitespace-tolerant', () => {
    for (const raw of ['shadow', 'SHADOW', '  Shadow  ']) {
      const service = build(raw);
      expect(service.isShadow).toBe(true);
      expect(service.shouldBlock(decision(), SITE)).toBe(false);
    }
  });

  /**
   * A typo in an env var must not silently disable authorization. `enforce` is
   * the fail-safe direction, and the mistake is logged at error level so it is
   * visible rather than mysterious.
   */
  it('falls back to enforce on an unrecognised value, loudly', () => {
    const service = build('shaodw');
    expect(service.current).toBe(ACCESS_POLICY_MODE.ENFORCE);
    expect(service.shouldBlock(decision(), SITE)).toBe(true);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('Unrecognised ACCESS_POLICY_MODE'),
    );
  });

  describe('shadow deny log', () => {
    it('records the first occurrence of a (tenant, feature, site) triple', () => {
      const service = build('shadow');
      service.shouldBlock(decision(), SITE);

      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('SHADOW-DENY'),
      );
    });

    /**
     * The value of the log is the DISTINCT set of things that would break, not
     * the volume. A hot route must not emit thousands of identical lines.
     */
    it('dedupes a repeat of the same triple', () => {
      const service = build('shadow');
      (Logger.prototype.warn as jest.Mock).mockClear();

      for (let i = 0; i < 50; i++) service.shouldBlock(decision(), SITE);

      const shadowLines = (
        Logger.prototype.warn as jest.Mock
      ).mock.calls.filter(([line]) => String(line).includes('SHADOW-DENY'));
      expect(shadowLines).toHaveLength(1);
    });

    it('records a different tenant separately', () => {
      const service = build('shadow');
      (Logger.prototype.warn as jest.Mock).mockClear();

      service.shouldBlock(decision('t1'), SITE);
      service.shouldBlock(decision('t2'), SITE);

      const shadowLines = (
        Logger.prototype.warn as jest.Mock
      ).mock.calls.filter(([line]) => String(line).includes('SHADOW-DENY'));
      expect(shadowLines).toHaveLength(2);
    });

    /**
     * A rollout log runs for weeks at info level. `decision.reason` names the
     * clinic's subscription status, so it must stay server-side in the
     * exception's `internalContext` and never accumulate here.
     */
    it('never writes the internal reason into the log line', () => {
      const service = build('shadow');
      (Logger.prototype.warn as jest.Mock).mockClear();

      service.shouldBlock(decision(), SITE);

      const line = String(
        (Logger.prototype.warn as jest.Mock).mock.calls.find(([l]) =>
          String(l).includes('SHADOW-DENY'),
        )?.[0],
      );
      expect(line).not.toContain('CANCELLED');
      expect(line).toContain('tenant=t1');
      expect(line).toContain(`feature=${FeatureKey.WHATSAPP}`);
    });

    it('does not log at all in enforce mode', () => {
      const service = build('enforce');
      (Logger.prototype.warn as jest.Mock).mockClear();

      expect(service.shouldBlock(decision(), SITE)).toBe(true);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });
  });
});

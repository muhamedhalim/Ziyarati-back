import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappProviderFactory } from './providers/whatsapp-provider.factory';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { UsageService } from '../subscription-billing/usage.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import {
  AccessSource,
  QuotaPolicy,
} from '../subscription-billing/tenant-access-decision';

const TENANT = 't1';
const PAYLOAD = {
  tenantId: TENANT,
  accountId: 'acc-1',
  phoneNumberId: 'p1',
  mode: 'REAL',
  to: '966500000000',
  text: 'hello',
};

/**
 * `sendSession` — the free-form reply channel — is the seam three separate
 * callers reach: the WhatsApp inbound AI bridge, the live-agent handover reply,
 * and the workflow WHATSAPP action. Until this gate existed it was the ONLY
 * outbound WhatsApp path with no entitlement check and no metering: a clinic
 * whose WhatsApp capability was never granted (or was administratively
 * suspended) still sent real messages down all three, and none of them moved
 * the `WHATSAPP_MESSAGES` counter, so a paying clinic could exceed its plan cap
 * without the meter registering it.
 *
 * The gate lives HERE rather than in the three callers on purpose — a fourth
 * caller added later inherits it by construction.
 */
describe('WhatsappMessagingService.sendSession — entitlement + metering seam', () => {
  let service: WhatsappMessagingService;
  let provider: { name: string; send: jest.Mock; sendSession: jest.Mock };
  let access: { resolve: jest.Mock; shouldBlock: jest.Mock };
  let usage: { incrementIfWithinLimit: jest.Mock; release: jest.Mock };

  const allowed = {
    allowed: true,
    tenantId: TENANT,
    featureKey: FeatureKey.WHATSAPP,
    source: AccessSource.FEATURE_OVERRIDE,
    quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
  };
  const denied = {
    allowed: false,
    tenantId: TENANT,
    featureKey: FeatureKey.WHATSAPP,
    source: AccessSource.DENIED,
    quotaPolicy: QuotaPolicy.BLOCKED,
    reason: 'Feature is administratively suspended for this tenant',
  };

  beforeEach(() => {
    provider = {
      name: 'meta',
      send: jest.fn(),
      sendSession: jest
        .fn()
        .mockResolvedValue({ success: true, providerMessageId: 'wamid.1' }),
    };
    access = {
      resolve: jest.fn().mockResolvedValue(allowed),
      shouldBlock: jest.fn().mockReturnValue(true),
    };
    usage = {
      incrementIfWithinLimit: jest
        .fn()
        .mockResolvedValue({ applied: true, used: 0, limit: null }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    service = new WhatsappMessagingService(
      { resolve: () => provider } as unknown as WhatsappProviderFactory,
      access as unknown as AccessControlService,
      usage as unknown as UsageService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('sends and meters when the tenant holds the capability', async () => {
    const res = await service.sendSession(PAYLOAD);

    expect(res.success).toBe(true);
    expect(access.resolve).toHaveBeenCalledWith(TENANT, FeatureKey.WHATSAPP);
    expect(usage.incrementIfWithinLimit).toHaveBeenCalledWith(
      TENANT,
      USAGE_METRIC.WHATSAPP_MESSAGES,
      1,
    );
    expect(provider.sendSession).toHaveBeenCalled();
  });

  it('never reaches the provider when the capability is denied', async () => {
    access.resolve.mockResolvedValueOnce(denied);

    const res = await service.sendSession(PAYLOAD);

    expect(res.success).toBe(false);
    expect(provider.sendSession).not.toHaveBeenCalled();
    expect(usage.incrementIfWithinLimit).not.toHaveBeenCalled();
  });

  /**
   * A suspension is the incident kill-switch and outranks a paid subscription,
   * so it has to stop the bot reply too — that is the path an operator is most
   * likely to be trying to silence.
   */
  it('refuses without leaking the internal reason to the caller', async () => {
    access.resolve.mockResolvedValueOnce(denied);

    const res = await service.sendSession(PAYLOAD);

    expect(res.error).toBe(
      'WhatsApp messaging is not available for this clinic',
    );
    expect(res.error).not.toContain('suspended');
    expect(res.error).not.toContain('subscription');
  });

  it('fails CLOSED when the decision cannot be resolved', async () => {
    access.resolve.mockRejectedValueOnce(new Error('db down'));

    const res = await service.sendSession(PAYLOAD);

    expect(res.success).toBe(false);
    expect(provider.sendSession).not.toHaveBeenCalled();
  });

  it('refuses when the monthly message cap is exhausted', async () => {
    usage.incrementIfWithinLimit.mockResolvedValueOnce({
      applied: false,
      used: 100,
      limit: 100,
    });

    const res = await service.sendSession(PAYLOAD);

    expect(res.success).toBe(false);
    expect(provider.sendSession).not.toHaveBeenCalled();
  });

  it('releases the reservation when the provider fails', async () => {
    provider.sendSession.mockResolvedValueOnce({
      success: false,
      error: 'meta rejected',
    });

    await service.sendSession(PAYLOAD);

    expect(usage.release).toHaveBeenCalledWith(
      TENANT,
      USAGE_METRIC.WHATSAPP_MESSAGES,
      1,
    );
  });

  it('releases the reservation when the provider throws', async () => {
    provider.sendSession.mockRejectedValueOnce(new Error('socket hang up'));

    const res = await service.sendSession(PAYLOAD);

    expect(res.success).toBe(false);
    expect(usage.release).toHaveBeenCalled();
  });

  // Plan §18 — shadow mode records the would-be refusal and lets traffic flow.
  it('sends anyway in shadow mode, still metered', async () => {
    access.resolve.mockResolvedValueOnce(denied);
    access.shouldBlock.mockReturnValueOnce(false);

    const res = await service.sendSession(PAYLOAD);

    expect(res.success).toBe(true);
    expect(usage.incrementIfWithinLimit).toHaveBeenCalled();
  });

  it('still reports a provider that cannot do session sends', async () => {
    service = new WhatsappMessagingService(
      { resolve: () => ({ name: 'stub', send: jest.fn() }) } as never,
      access as unknown as AccessControlService,
      usage as unknown as UsageService,
    );

    const res = await service.sendSession(PAYLOAD);

    expect(res.success).toBe(false);
    expect(res.error).toContain('does not support session messages');
    // Refused before admission, so nothing was reserved to release.
    expect(usage.incrementIfWithinLimit).not.toHaveBeenCalled();
  });
});

describe('WhatsappMessagingService.sendSession — content policy (residency plan P5)', () => {
  let provider: { name: string; send: jest.Mock; sendSession: jest.Mock };
  let usage: { incrementIfWithinLimit: jest.Mock; release: jest.Mock };

  const build = (config?: Record<string, unknown>) =>
    new WhatsappMessagingService(
      { resolve: () => provider } as unknown as WhatsappProviderFactory,
      {
        resolve: jest.fn().mockResolvedValue({ allowed: true, source: 'PLAN' }),
        shouldBlock: jest.fn().mockReturnValue(true),
      } as unknown as AccessControlService,
      usage as unknown as UsageService,
      config ? ({ get: (k: string, d?: unknown) => config[k] ?? d } as never) : undefined,
    );

  beforeEach(() => {
    provider = {
      name: 'meta',
      send: jest.fn(),
      sendSession: jest.fn().mockResolvedValue({ success: true, providerMessageId: 'w1' }),
    };
    usage = {
      incrementIfWithinLimit: jest.fn().mockResolvedValue({ applied: true, used: 0, limit: null }),
      release: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('refuses a reply carrying a national ID — no provider call, no quota reserved, no value in the error', async () => {
    const res = await build().sendSession({ ...PAYLOAD, text: 'Your ID is 1012345678' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('content policy');
    expect(res.error).toContain('national_id');
    expect(res.error).not.toContain('1012345678');
    expect(provider.sendSession).not.toHaveBeenCalled();
    expect(usage.incrementIfWithinLimit).not.toHaveBeenCalled();
  });

  it('sends an ordinary reply', async () => {
    const res = await build().sendSession({ ...PAYLOAD, text: 'See you at 09:30' });
    expect(res.success).toBe(true);
  });

  it('monitor mode lets it through (and only logs); off mode does not even look', async () => {
    const monitored = await build({ WHATSAPP_CONTENT_POLICY: 'monitor' }).sendSession({
      ...PAYLOAD,
      text: 'Your ID is 1012345678',
    });
    expect(monitored.success).toBe(true);

    const off = await build({ WHATSAPP_CONTENT_POLICY: 'off' }).sendSession({
      ...PAYLOAD,
      text: 'Your ID is 1012345678',
    });
    expect(off.success).toBe(true);
  });
});

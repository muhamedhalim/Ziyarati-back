import { IntegrationAdmissionService } from './integration-admission.service';
import { ADMISSION_LIMITS, ADMISSION_OP } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

function build(env: Record<string, string> = {}, consume?: jest.Mock) {
  const limiter = { consume: consume ?? jest.fn().mockResolvedValue({ allowed: true }) };
  const config = { get: (k: string) => env[k] };
  const svc = new IntegrationAdmissionService(limiter as never, config as never, {} as never, {} as never);
  return { svc, limiter };
}

describe('unsigned inbound admission (F03)', () => {
  it('charges a per-IP bucket, a per-connection bucket and a per-tenant bucket — separate from the signed op', async () => {
    const t = build();
    await t.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId: 't1', connectionId: 'c1', ip: '203.0.113.9' });
    const buckets = t.limiter.consume.mock.calls.map((c) => c[1] as string);
    expect(buckets).toHaveLength(3);
    expect(buckets.some((b) => b.startsWith('int:inbound.webhook.unsigned:ip:c1:'))).toBe(true);
    expect(buckets).toContain('int:inbound.webhook.unsigned:conn:c1');
    expect(buckets).toContain('int:inbound.webhook.unsigned:tenant');
    // none of them is a signed-event bucket
    expect(buckets.every((b) => !b.startsWith('int:inbound.webhook:'))).toBe(true);
  });

  it('never puts the raw address in the bucket key and keeps two sources apart', async () => {
    const t = build();
    await t.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId: 't1', connectionId: 'c1', ip: '203.0.113.9' });
    await t.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId: 't1', connectionId: 'c1', ip: '198.51.100.7' });
    const ipBuckets = t.limiter.consume.mock.calls.map((c) => c[1] as string).filter((b) => b.includes(':ip:'));
    expect(ipBuckets).toHaveLength(2);
    expect(ipBuckets[0]).not.toBe(ipBuckets[1]);
    expect(ipBuckets.join()).not.toContain('203.0.113.9');
  });

  it('uses the documented defaults and honours the env override per scope', async () => {
    const lim = ADMISSION_LIMITS[ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED];
    const a = build();
    await a.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId: 't1', connectionId: 'c1', ip: '1.1.1.1' });
    const rates = a.limiter.consume.mock.calls.map((c) => c[2].ratePerMinute);
    expect(rates).toEqual([lim.perIpPerMin, lim.perTenantPerMin, lim.perConnectionPerMin]);

    const b = build({ INTEGRATION_RL_INBOUND_WEBHOOK_UNSIGNED_IP: '5' });
    await b.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId: 't1', connectionId: 'c1', ip: '1.1.1.1' });
    expect(b.limiter.consume.mock.calls[0][2].ratePerMinute).toBe(5);
  });

  it('429 when exhausted (with a retry hint) and 503 when the limiter is down — never fail-open', async () => {
    const exhausted = build({}, jest.fn().mockResolvedValue({ allowed: false, reason: 'RATE', retryAfterMs: 4000 }));
    await expect(
      exhausted.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId: 't1', connectionId: 'c1', ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, publicContext: { retryAfterMs: 4000 } });

    const down = build({}, jest.fn().mockRejectedValue(new Error('redis down')));
    await expect(
      down.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, { tenantId: 't1', connectionId: 'c1', ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });
  });

  it('the signed op is unchanged (no per-IP scope)', async () => {
    const t = build();
    await t.svc.admit(ADMISSION_OP.INBOUND_WEBHOOK, { tenantId: 't1', connectionId: 'c1', ip: '1.1.1.1' });
    const buckets = t.limiter.consume.mock.calls.map((c) => c[1] as string);
    expect(buckets).toEqual(['int:inbound.webhook:tenant', 'int:inbound.webhook:conn:c1']);
  });
});

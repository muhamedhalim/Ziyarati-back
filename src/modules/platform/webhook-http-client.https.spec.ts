import { deliverWebhookRequest } from './webhook-http-client';

/**
 * F04 at the DELIVERY boundary — no mocks: the real guard runs. An endpoint that
 * was stored with `http://` before HTTPS became mandatory must fail permanently
 * (no socket is ever opened) with a message the clinic can act on.
 */
describe('deliverWebhookRequest — https is required in production (F04)', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.WEBHOOK_ALLOW_INSECURE_HTTP;
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('a stored http:// endpoint is a PERMANENT failure with an actionable message', async () => {
    const r = await deliverWebhookRequest('http://93.184.216.34/hook', '{}', {}, 500);
    expect(r.ok).toBe(false);
    expect(r.transient).toBe(false);
    expect(r.error).toBe('Delivery blocked: the endpoint URL must use https');
  });

  it('a blocked https target keeps the generic non-oracle message', async () => {
    const r = await deliverWebhookRequest('https://127.0.0.1/hook', '{}', {}, 500);
    expect(r.ok).toBe(false);
    expect(r.transient).toBe(false);
    expect(r.error).toBe('Delivery blocked: target address is not allowed');
  });

  it('NAT64 / 6to4 forms of internal addresses are blocked at delivery too', async () => {
    for (const u of ['https://[64:ff9b::7f00:1]/', 'https://[2002:7f00:1::]/']) {
      const r = await deliverWebhookRequest(u, '{}', {}, 500);
      expect(r).toMatchObject({ ok: false, transient: false });
    }
  });
});

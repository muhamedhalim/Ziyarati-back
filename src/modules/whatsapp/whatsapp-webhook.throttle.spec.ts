/**
 * The POST budget is read per request (the decorator runs before `.env` is
 * loaded), so these load the controller module fresh under each environment.
 */
describe('eventsThrottleLimit', () => {
  const load = (nodeEnv: string, perMin?: string) => {
    const prevEnv = process.env.NODE_ENV;
    const prevLimit = process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN;
    process.env.NODE_ENV = nodeEnv;
    if (perMin === undefined)
      delete process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN;
    else process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN = perMin;
    try {
      let mod: typeof import('./whatsapp-webhook.controller');
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require('./whatsapp-webhook.controller');
      });
      return mod!;
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevLimit === undefined)
        delete process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN;
      else process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN = prevLimit;
    }
  };

  it('defaults to 3000 a minute in production — far above the old 60 shared by every clinic behind Meta’s addresses', () => {
    const m = load('production');
    expect(m.eventsThrottleLimit()).toBe(3000);
    expect(m.WHATSAPP_EVENTS_THROTTLE_DEFAULT).toBe(3000);
  });

  it('takes WHATSAPP_WEBHOOK_THROTTLE_PER_MIN, read when asked rather than at import', () => {
    const m = load('production', '500');
    expect(m.eventsThrottleLimit()).toBe(3000); // env restored after load
    process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN = '500';
    try {
      expect(m.eventsThrottleLimit()).toBe(500);
    } finally {
      delete process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN;
    }
  });

  it.each(['0', '-5', 'abc', ''])(
    'ignores an unusable value (%p) and keeps the default',
    (bad) => {
      const m = load('production');
      process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN = bad;
      try {
        expect(m.eventsThrottleLimit()).toBe(3000);
      } finally {
        delete process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN;
      }
    },
  );

  it('is effectively unlimited under test, like the app-wide default', () => {
    expect(load('test').eventsThrottleLimit()).toBe(1_000_000);
  });

  it('only the POST events route uses it; the GET handshakes keep their own small budget', () => {
    const { WhatsappWebhookController } = load('production');
    const reflect = (name: string) =>
      Reflect.getMetadataKeys(
        WhatsappWebhookController.prototype[
          name as keyof typeof WhatsappWebhookController.prototype
        ],
      ).filter((k: string) => String(k).startsWith('THROTTLER:LIMIT'));
    expect(reflect('ingest').length).toBeGreaterThan(0);
    const get = (name: string) =>
      Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        WhatsappWebhookController.prototype[
          name as keyof typeof WhatsappWebhookController.prototype
        ],
      );
    expect(get('verify')).toBe(60);
    expect(get('verifyOnEventsPath')).toBe(60);
    expect(typeof get('ingest')).toBe('function');
  });
});

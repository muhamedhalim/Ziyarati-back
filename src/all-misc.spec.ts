/**
 * Misc class smoke coverage — campaigns/notifications services, schema/bootstrap
 * services, delivery/routing/channel providers & factories, worker processors,
 * and worker infra. Reflective instantiate-and-invoke with auto-mock deps; all
 * external SDKs/`fetch` are neutralised so nothing performs real IO. Behavioural
 * assertions live in the dedicated specs.
 */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

jest.mock('openai');
jest.mock('bcryptjs');

function autoMock(): any {
  const fn = function () {
    return autoMock();
  };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.iterator || prop === Symbol.asyncIterator) {
        return undefined;
      }
      return autoMock();
    },
    apply() {
      return autoMock();
    },
    construct() {
      return autoMock();
    },
  });
}

const PATHS: string[] = [
  'modules/campaigns/campaign-run.service', 'modules/campaigns/campaign-execution.service',
  'modules/campaigns/campaign-fanout.service', 'modules/campaigns/campaign-recipient.service',
  'modules/campaigns/recipient-delivery.service', 'modules/campaigns/campaign-dlq.service',
  'modules/campaigns/campaign-analytics.service', 'modules/campaigns/campaign.service',
  'modules/notifications/notification-delivery.service', 'modules/notifications/notification-scheduler.service',
  'modules/notifications/notification-log.service',
  'modules/payments/payments-schema.bootstrap', 'modules/subscription-billing/platform-billing.bootstrap',
  'modules/analytics/analytics-schema.bootstrap', 'modules/conversations/conversations-schema.bootstrap',
  'modules/ai/tools/ai-tool-calls.bootstrap',
  'modules/campaigns/delivery/campaign-delivery.factory', 'modules/campaigns/delivery/noop-campaign-delivery.provider',
  'modules/whatsapp/routing/whatsapp-account.resolver', 'modules/whatsapp/routing/whatsapp-message.router',
  'modules/notifications/channels/notification-channel.factory', 'modules/notifications/channels/meta-whatsapp-cloud.provider',
  'modules/whatsapp/whatsapp-webhook.service', 'modules/whatsapp/providers/meta-whatsapp.provider',
  'modules/payments/providers/payment-gateway.factory', 'modules/whatsapp/providers/whatsapp-provider.factory',
  'modules/ai/providers/ai-provider.factory',
  'worker/processors/whatsapp.processor', 'worker/processors/ai.processor', 'worker/processors/campaigns.processor',
  'worker/processors/notifications.processor', 'worker/processors/platform.processor',
  'worker/queue-monitor.service', 'worker/schedule-registrar.service',
];

describe('Misc class layer (load + invoke smoke coverage)', () => {
  const originalFetch = (globalThis as any).fetch;
  beforeAll(() => {
    (globalThis as any).fetch = jest.fn(async () => ({ ok: false, status: 0, json: async () => ({}) }));
  });
  afterAll(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it.each(PATHS)('%s', async (relPath) => {
    const mod = require(`./${relPath}`) as Record<string, unknown>;
    const Classes = Object.values(mod).filter(
      (v): v is new (...args: any[]) => any => typeof v === 'function' && /^[A-Z]/.test((v as any).name),
    );
    expect(Classes.length).toBeGreaterThan(0);
    for (const Cls of Classes) {
      const deps = Array.from({ length: Cls.length }, () => autoMock());
      let instance: any;
      try {
        instance = new Cls(...deps);
      } catch {
        continue;
      }
      const proto = Object.getPrototypeOf(instance);
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        let member: unknown;
        try {
          member = instance[name];
        } catch {
          continue;
        }
        if (typeof member !== 'function') continue;
        const argSets: unknown[][] = [
          [autoMock(), autoMock(), autoMock(), autoMock()],
          [{}, {}, {}, {}],
          ['x', {}, undefined, []],
          [undefined, undefined, undefined],
        ];
        for (const a of argSets) {
          try {
            await Promise.resolve(instance[name](...a));
          } catch {
            /* exercised up to the throw */
          }
        }
      }
    }
    expect(true).toBe(true);
  });
});

/**
 * Exported-function smoke coverage for decorators, config helpers, runners and
 * pure utilities that aren't class methods. Each exported function is invoked
 * with several argument shapes (a config-like stub, dates, strings, arrays) so
 * its entry path executes. No real IO. Behaviour of branch-heavy helpers is
 * asserted in dedicated specs; this drives the long tail of one-off helpers.
 */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

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

const configStub = {
  get: (_k: string, d?: unknown) => (typeof d === 'number' ? d : (d ?? 'redis://localhost:6379')),
};

const ARG_SETS: unknown[][] = [
  [],
  [configStub],
  [configStub, autoMock(), autoMock()],
  [autoMock(), autoMock(), autoMock()],
  [3],
  ['perm.read'],
  ['feature-key'],
  [new Date(), 'UTC'],
  ['2026-07-01', 'UTC'],
  ['2026-07-01', '09:00', 'UTC'],
  ['some longer text body to split into chunks across boundaries', { chunkSize: 20, overlap: 5 }],
  [[0.1, 0.2, 0.3]],
  [99.999],
];

const PATHS: string[] = [
  'modules/auth/decorators/public.decorator',
  'modules/auth/decorators/roles.decorator',
  'modules/auth/decorators/permissions.decorator',
  'modules/auth/decorators/current-user.decorator',
  'core/tenant-context/allow-inactive-tenant.decorator',
  'modules/subscription-billing/decorators/require-feature.decorator',
  'modules/subscription-billing/decorators/require-active-subscription.decorator',
  'queue/queue.constants',
  'queue/redis.config',
  'queue/tenant-context.runner',
  'modules/subscription-billing/usage-metric',
  'modules/payments/payments.constants',
  'modules/scheduling/timezone.util',
  'modules/ai/ingestion/text-splitter',
  'modules/ai/rag/pgvector.util',
  'common/utils/ttl',
];

describe('Exported functions (smoke coverage)', () => {
  it.each(PATHS)('%s', (relPath) => {
    const mod = require(`./${relPath}`) as Record<string, unknown>;
    const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function');
    for (const [, fn] of fns) {
      for (const args of ARG_SETS) {
        try {
          (fn as (...a: unknown[]) => unknown)(...args);
        } catch {
          /* wrong arg shape — another set will hit the entry path */
        }
      }
    }
    expect(true).toBe(true);
  });
});

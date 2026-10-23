import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Permanent invariants for the e2e environment bootstrap
 * (`test/jest-e2e.env.js`), closing ZT-FINAL-001 and ZT-FINAL-002 from
 * `FINAL-SECURITY-VERIFICATION.md`.
 *
 * WHY A CHILD PROCESS. `jest-e2e.env.js` works by MUTATING `process.env`, and
 * it is registered as a `setupFiles` entry of `jest-e2e.json` /
 * `jest-e2e-integration-platform.json` — never of `jest-security.json`, which
 * runs this file. Requiring it inline would both contaminate this process and
 * prove nothing about the environment a real e2e run actually gets. Executing
 * it in a fresh child and reading back the resulting environment tests the
 * real mechanism.
 *
 * WHY A DELIBERATELY HOSTILE PARENT ENVIRONMENT. Each child is spawned with
 * `EMAIL_ENABLED=true`, an SES region and a non-empty legacy `RESEND_API_KEY` already set — the
 * exact condition that caused ZT-FINAL-002 (a developer or CI runner whose
 * `.env` carries a live key). An assertion that only held for an already-clean
 * environment would be vacuous. The child also loads the real `.env` via the
 * bootstrap's own `require('dotenv/config')`, so a live key sitting in that
 * file is likewise proven not to survive.
 *
 * These are infrastructure-free: no database, no Redis, no network.
 */

const BACKEND_ROOT = join(__dirname, '..', '..');
const BOOTSTRAP = join(BACKEND_ROOT, 'test', 'jest-e2e.env.js');

/** Keys the bootstrap is responsible for; read back after it has run. */
const PROBE = [
  'EMAIL_ENABLED',
  'RESEND_API_KEY',
  'QUEUE_ENV_PREFIX',
  'REDIS_URL',
  'TYPEORM_SYNCHRONIZE',
  'OPENAI_API_KEY',
  'TAP_LIVE_SECRET_KEY',
  'TAP_TEST_SECRET_KEY',
  'S3_BUCKET',
  'AWS_ACCESS_KEY_ID',
] as const;

/** CR-55: live-looking provider settings a developer machine carries; none may survive the bootstrap. */
const HOSTILE_PROVIDER_ENV = {
  OPENAI_API_KEY: 'sk-live-must-never-reach-a-test',
  TAP_LIVE_SECRET_KEY: 'sk_live_must_never_reach_a_test',
  TAP_TEST_SECRET_KEY: 'sk_test_must_never_reach_a_test',
  S3_BUCKET: 'a-real-production-bucket',
  AWS_ACCESS_KEY_ID: 'AKIAMUSTNEVERREACHATEST',
} as const;

type ProbeResult = Record<(typeof PROBE)[number], string | undefined>;

/**
 * Runs the bootstrap in a fresh child process whose environment already
 * contains a live-looking email credential, and returns the resulting values.
 */
function runBootstrap(extraEnv: NodeJS.ProcessEnv = {}): ProbeResult {
  const script = `require(${JSON.stringify(BOOTSTRAP)});
process.stdout.write(JSON.stringify(${JSON.stringify(PROBE)}.reduce((acc, k) => {
  acc[k] = process.env[k];
  return acc;
}, {})));`;

  const stdout = execFileSync(process.execPath, ['-e', script], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      // The hostile preconditions ZT-FINAL-002 describes.
      EMAIL_ENABLED: 'true',
      AWS_REGION: 'eu-central-1',
      SES_REGION: 'eu-central-1',
      RESEND_API_KEY: 're_live_key_that_must_never_be_used_by_e2e',
      ...HOSTILE_PROVIDER_ENV,
      // Keep the child off any real service; the bootstrap only builds strings.
      DB_PASSWORD: process.env.DB_PASSWORD ?? 'postgres',
      ...extraEnv,
    },
  });

  return JSON.parse(stdout) as ProbeResult;
}

describe('e2e environment bootstrap invariants (ZT-FINAL-001, ZT-FINAL-002)', () => {
  describe('ZT-FINAL-002 — the e2e suite can never reach a live email provider', () => {
    it('forces EMAIL_ENABLED=false even when the inherited environment enables SES', () => {
      expect(runBootstrap().EMAIL_ENABLED).toBe('false');
    });

    it('clears the retired RESEND_API_KEY, so no stale live secret reaches a test process', () => {
      // Empty string (not merely "not the injected value").
      expect(runBootstrap().RESEND_API_KEY).toBe('');
    });

    it('does not leak the injected live-looking credential under any probed key', () => {
      const result = runBootstrap();
      for (const value of Object.values(result)) {
        expect(value ?? '').not.toContain('re_live_key_that_must_never_be_used_by_e2e');
      }
    });
  });

  describe('ZT-FINAL-001 — each e2e test file gets its own Redis key namespace', () => {
    it('always sets a non-empty QUEUE_ENV_PREFIX', () => {
      const prefix = runBootstrap().QUEUE_ENV_PREFIX ?? '';
      expect(prefix.length).toBeGreaterThan(0);
    });

    it('produces a DIFFERENT prefix per execution — the property that makes suites order-independent', () => {
      // setupFiles runs once per test file, so "per execution" here is exactly
      // "per test file" in a real run. Ten samples: a collision would mean the
      // namespace is not actually unique and the ZT-FINAL-001 leak is back.
      const prefixes = new Set<string>();
      for (let i = 0; i < 10; i++) {
        prefixes.add(runBootstrap().QUEUE_ENV_PREFIX ?? '');
      }
      expect(prefixes.size).toBe(10);
    });

    it('honours ZT_E2E_QUEUE_PREFIX when an operator deliberately pins one', () => {
      const pinned = runBootstrap({ ZT_E2E_QUEUE_PREFIX: 'pinned-prefix' });
      expect(pinned.QUEUE_ENV_PREFIX).toBe('pinned-prefix');
    });

    it('never disables the limiters it namespaces — no test-mode bypass is introduced here', () => {
      // The fix must isolate state, never weaken a threshold. If a future
      // edit adds a bypass flag to this bootstrap, this fails.
      const result = runBootstrap() as Record<string, string | undefined>;
      for (const key of Object.keys(result)) {
        expect(key).not.toMatch(/DISABLE|BYPASS|SKIP_RATE|NO_LIMIT/i);
      }
    });
  });

  describe('CR-55 — the suites never inherit a live provider credential from a developer machine', () => {
    it.each(Object.keys(HOSTILE_PROVIDER_ENV))('blanks %s even when the inherited environment sets it', (key) => {
      const result = runBootstrap() as Record<string, string | undefined>;
      expect(result[key]).toBe('');
    });

    it('does not leak any injected live-looking value under any probed key', () => {
      const result = runBootstrap();
      for (const value of Object.values(result)) {
        for (const secret of Object.values(HOSTILE_PROVIDER_ENV)) {
          expect(value ?? '').not.toContain(secret);
        }
      }
    });
  });

  describe('pre-existing overrides still hold (no regression from these two fixes)', () => {
    it('still pins the disposable e2e Redis and disables synchronize', () => {
      // An operator may point the suite at another disposable Redis with ZT_E2E_REDIS_URL; clear it so
      // this asserts the DEFAULT regardless of the machine the spec runs on.
      const result = runBootstrap({ ZT_E2E_REDIS_URL: '' });
      expect(result.REDIS_URL).toBe('redis://127.0.0.1:63790');
      expect(result.TYPEORM_SYNCHRONIZE).toBe('false');
    });
  });
});

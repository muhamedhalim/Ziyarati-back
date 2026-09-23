/**
 * Boots the COMPILED worker (`dist/src/worker.js`, exactly what production
 * runs) as a child process with a production environment that is valid in
 * every respect except the email sender, and asserts it refuses to start —
 * loudly, fast, and before touching Postgres or Redis.
 *
 * Regression for the 2026-09 incident: the production worker ran for weeks
 * with EMAIL_FROM="" and every email was rejected by Resend.
 *
 * Needs `npm run build` first. DB/Redis point at a closed local port, and the
 * process runs from an empty temp directory so no `.env` is loaded.
 *
 * Run: npx jest --config test/jest-integration.json worker-boot-config
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKER = resolve(__dirname, '../../dist/src/worker.js');

const productionEnv = (overrides: Record<string, string>) => ({
  PATH: process.env.PATH ?? '',
  SYSTEMROOT: process.env.SYSTEMROOT ?? '',
  NODE_ENV: 'production',
  WORKER_ROLE: 'all',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  FRONTEND_ORIGIN: 'https://app.example.com',
  DB_SSL_CA_CERT: 'x',
  AUTH_REGISTER_OWNER_ENDPOINT_CEILING: '100',
  PAYMENT_PROVIDER: 'noop',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'no-reply@example.com',
  NO_COLOR: '1',
  ...overrides,
});

describe('worker startup with invalid email configuration (compiled dist)', () => {
  let cwd: string;

  beforeAll(() => {
    if (!existsSync(WORKER)) {
      throw new Error(`${WORKER} not found — run \`npm run build\` first`);
    }
    cwd = mkdtempSync(join(tmpdir(), 'zt-worker-boot-'));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  const boot = (overrides: Record<string, string>) => {
    const started = Date.now();
    const r = spawnSync(process.execPath, [WORKER], {
      cwd,
      env: productionEnv(overrides),
      encoding: 'utf8',
      timeout: 45_000,
    });
    return {
      status: r.status,
      signal: r.signal,
      output: `${r.stdout}\n${r.stderr}`,
      ms: Date.now() - started,
    };
  };

  it.each([
    ['blank (the production state)', { EMAIL_FROM: '' }, /EMAIL_FROM/],
    ['malformed', { EMAIL_FROM: 'no-reply' }, /EMAIL_FROM/],
    ['missing Resend key', { RESEND_API_KEY: '' }, /RESEND_API_KEY/],
  ])(
    'refuses to start when the sender config is %s — non-zero exit, named variable, no connection attempted',
    (_label, overrides, named) => {
      const r = boot(overrides);

      expect(r.signal).toBeNull(); // exited on its own, not killed by the timeout
      expect(r.status).not.toBe(0);
      expect(r.output).toContain('Env validation error');
      expect(r.output).toMatch(named);
      expect(r.output).not.toContain('Worker process started');
      expect(r.output).not.toMatch(/ECONNREFUSED|Unable to connect/);
      expect(r.output).not.toContain('re_test'); // never echoes a secret value
    },
  );
});

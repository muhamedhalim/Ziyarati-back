import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `analytics-no-branch.redis.spec.ts` needs a real Redis on :63790 and, because GitHub sets `CI=true`,
 * treats a missing one as a FAILURE (test/utils/require-infra.ts) — which is the behaviour we want.
 * The cost is that every CI job that runs the default unit suite (a bare `npx jest`, which picks up
 * every `src/**\/*.spec.ts`) must provision that Redis itself. `deploy-aws.yml` once ran `npx jest --ci`
 * with a Postgres service only and went red on the Redis spec. Nothing else ties a workflow's job
 * list to a spec's infrastructure, so this does.
 */
const WORKFLOWS = resolve(__dirname, '../../.github/workflows');
const REDIS_PORT = '63790';

/** Splits a workflow into `{ name, body }` per job (jobs are the 2-space-indented keys under `jobs:`). */
function jobs(file: string): { name: string; body: string }[] {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const out: { name: string; body: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) out.push({ name: head[1], body: [] });
    else if (out.length) out[out.length - 1].body.push(line);
  }
  return out.map((j) => ({ name: j.name, body: j.body.join('\n') }));
}

/** True for a bare default-config jest run (not `--config ./test/...`, which selects other suites). */
const runsDefaultUnitSuite = (body: string) =>
  body
    .split('\n')
    .some(
      (l) =>
        /\bnpx jest\b/.test(l) && !/--config\b/.test(l) && !/^\s*#/.test(l),
    );

describe('the infrastructure-free security step lists no database-booting spec', () => {
  // `ai-w10-quota-failclosed` boots AppModule against `ziyarati_e2e`, which the `unit` job never creates:
  // it failed there with `database "ziyarati_e2e" does not exist`. Specs that need a database belong to the
  // `ai-security` job, which provisions one.
  const ci = readFileSync(join(WORKFLOWS, 'backend-ci.yml'), 'utf8');
  const step =
    /Security invariants \(infrastructure-free\)[\s\S]*?--testPathPatterns "test\/security\/\(([^)]+)\)/.exec(
      ci,
    );
  const listed = step ? step[1].split('|') : [];
  const securityDir = resolve(__dirname, '../../test/security');

  it('finds the step and its spec list', () => {
    expect(listed.length).toBeGreaterThan(0);
  });

  it.each(listed)('%s does not boot the app or the audit harness', (name) => {
    const source = readFileSync(join(securityDir, `${name}.spec.ts`), 'utf8');
    expect(source).not.toMatch(
      /buildAiAuditHarness|seedAiAudit|from '\.\.\/\.\.\/src\/app\.module'/,
    );
  });
});

describe('CI jobs that run the default unit suite provide Redis', () => {
  const files = existsSync(WORKFLOWS)
    ? readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
    : [];

  it('finds the workflows', () => {
    expect(files).toEqual(
      expect.arrayContaining(['backend-ci.yml', 'deploy-aws.yml']),
    );
  });

  const unitJobs = files.flatMap((f) =>
    jobs(f)
      .filter((j) => runsDefaultUnitSuite(j.body))
      .map((j) => [`${f} › ${j.name}`, j.body] as const),
  );

  it('there is at least one such job (backend-ci unit, deploy-aws build)', () => {
    expect(unitJobs.length).toBeGreaterThanOrEqual(2);
  });

  it.each(unitJobs)(
    '%s starts Redis on the port the spec defaults to',
    (_label, body) => {
      const publishesRedis = new RegExp(
        `-p ${REDIS_PORT}:6379[^\\n]*redis:|redis:[^\\n]*\\n(?:[^\\n]*\\n){0,6}[^\\n]*${REDIS_PORT}:6379`,
      ).test(body);
      expect(publishesRedis).toBe(true);
    },
  );
});

/**
 * The readiness wait is a script (`scripts/ci/wait-for-redis.sh`), not an inline loop. The inline
 * version pinged Redis INSIDE the container (not the published port the tests use), waited a fixed 30 s
 * even for a container that had already exited, and reported one bare message for every cause.
 */
describe('the Redis readiness wait', () => {
  const SCRIPT = resolve(__dirname, '../../scripts/ci/wait-for-redis.sh');

  describe('every workflow uses it', () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    const startSteps = files.flatMap((f) => {
      const text = readFileSync(join(WORKFLOWS, f), 'utf8').replace(/\r\n/g, '\n');
      return [...text.matchAll(/- name: Start Redis[^\n]*\n\s+run: \|\n((?:\s{10,}[^\n]*\n?)+)/g)].map(
        (m) => [`${f}`, m[1]] as const,
      );
    });

    it('finds the Start Redis steps', () => {
      expect(startSteps.length).toBeGreaterThanOrEqual(5);
    });

    it.each(startSteps)('%s: waits through the script with a bounded timeout, no inline loop', (_f, body) => {
      expect(body).toMatch(/bash scripts\/ci\/wait-for-redis\.sh zt-e2e-redis 63790 \d+/);
      expect(body).not.toMatch(/redis-cli ping|for i in|did not become ready/);
    });
  });

  describe('behaviour', () => {
    let dir: string;
    let shim: string;
    const servers: Server[] = [];

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'wait-redis-'));
      shim = join(dir, 'docker-shim.sh');
      // A stand-in for `docker`: container state comes from FAKE_STATE ("missing" => inspect fails).
      writeFileSync(
        shim,
        [
          '#!/usr/bin/env bash',
          'case "$1" in',
          '  inspect)',
          '    if [ "$FAKE_STATE" = "missing" ]; then echo "Error: No such object" >&2; exit 1; fi',
          '    case "$3" in',
          '      "{{.State.Status}}") echo "$FAKE_STATE" ;;',
          '      *) echo "status=$FAKE_STATE exitCode=137 oomKilled=true error= startedAt=then" ;;',
          '    esac ;;',
          '  ps) echo "FAKE-PS-ROW" ;;',
          '  port) echo "6379/tcp -> 0.0.0.0:63790" ;;',
          '  logs) echo "FAKE-REDIS-LOG: Out of memory" ;;',
          'esac',
          '',
        ].join('\n'),
      );
    });

    afterAll(async () => {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))));
      rmSync(dir, { recursive: true, force: true });
    });

    const run = (args: string[], env: Record<string, string>) =>
      new Promise<{ code: number | null; out: string; ms: number }>((resolveRun) => {
        const started = Date.now();
        const child = spawn('bash', [SCRIPT, ...args], {
          env: { ...process.env, DOCKER_BIN: `bash ${shim.replace(/\\/g, '/')}`, ...env },
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolveRun({ code, out, ms: Date.now() - started }));
      });

    /** A fake Redis: answers any PING with +PONG on a free port. */
    const fakeRedis = (): Promise<number> =>
      new Promise((resolveListen) => {
        const server = createServer((sock) => sock.on('data', () => sock.write('+PONG\r\n')));
        servers.push(server);
        server.listen(0, '127.0.0.1', () => resolveListen((server.address() as { port: number }).port));
      });

    /** A port nothing listens on. */
    const deadPort = async (): Promise<number> => {
      const port = await fakeRedis();
      const server = servers.pop()!;
      await new Promise((r) => server.close(() => r(undefined)));
      return port;
    };

    it('succeeds only when the PUBLISHED port answers PING', async () => {
      const port = await fakeRedis();
      const res = await run(['zt-e2e-redis', String(port), '10'], { FAKE_STATE: 'running' });
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/Redis ready on 127\.0\.0\.1:\d+/);
    }, 20_000);

    it('a running container whose port does not answer fails at the timeout, naming the port, with diagnostics', async () => {
      const port = await deadPort();
      const res = await run(['zt-e2e-redis', String(port), '2'], { FAKE_STATE: 'running' });
      expect(res.code).toBe(1);
      expect(res.ms).toBeLessThan(15_000); // bounded
      expect(res.out).toMatch(
        /::error::Redis did not become ready within 2s: container 'zt-e2e-redis' is running but 127\.0\.0\.1:\d+ did not answer PING/,
      );
      expect(res.out).toContain('FAKE-REDIS-LOG: Out of memory');
      expect(res.out).toContain('6379/tcp -> 0.0.0.0:63790');
    }, 30_000);

    it('an exited container fails FAST (not after the full timeout) and reports its exit code and OOM flag', async () => {
      const port = await deadPort();
      const res = await run(['zt-e2e-redis', String(port), '25'], { FAKE_STATE: 'exited' });
      expect(res.code).toBe(1);
      expect(res.ms).toBeLessThan(10_000);
      expect(res.out).toMatch(/::error::Redis is not available: container 'zt-e2e-redis' is exited, not running/);
      expect(res.out).toMatch(/exitCode=137 oomKilled=true/);
      expect(res.out).toContain('FAKE-REDIS-LOG');
    }, 30_000);

    it('a container that was never created is reported as missing', async () => {
      const res = await run(['zt-e2e-redis', '63790', '25'], { FAKE_STATE: 'missing' });
      expect(res.code).toBe(1);
      expect(res.out).toMatch(/container 'zt-e2e-redis' is missing, not running/);
    }, 30_000);

    it('rejects missing or non-numeric arguments instead of waiting', async () => {
      expect((await run([], { FAKE_STATE: 'running' })).code).toBe(2);
      expect((await run(['c', 'abc'], { FAKE_STATE: 'running' })).code).toBe(2);
      expect((await run(['c', '63790', 'soon'], { FAKE_STATE: 'running' })).code).toBe(2);
    });
  });
});

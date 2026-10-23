import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

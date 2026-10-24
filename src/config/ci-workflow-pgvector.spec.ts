import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * pgvector in CI. `ai-audit.yml` once ran its deterministic suite on a plain `postgres:16` service: the
 * AI migration soft-skips outside production, `PgVectorBootstrapService` logged
 * `extension "vector" is not available (/usr/share/postgresql/16/extension/vector.control)`, det-06 (the
 * vector retrieval path) failed and every later query for `ai_kb_embeddings` found no table. Nothing tied
 * a job's Postgres image to what its steps need, so this does — and it pins the CI major to production's.
 */
const BACK = resolve(__dirname, '../..');
const WORKFLOWS = join(BACK, '.github/workflows');

/** `job -> body` for each job (2-space-indented keys under `jobs:`). */
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

/** `service name -> image` for the `services:` block of a job (service keys sit at 6 spaces, `image:` at 8). */
function serviceImages(body: string): Record<string, string> {
  const images: Record<string, string> = {};
  const re = /^ {6}([A-Za-z0-9_-]+):\s*\n {8}image:\s*(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) images[m[1]] = m[2];
  return images;
}

const productionMajor = (): string => {
  const tfvars = readFileSync(
    join(BACK, 'infra/terraform/environments/production/terraform.tfvars'),
    'utf8',
  );
  const m = /engine_major_version\s*=\s*"(\d+)"/.exec(tfvars);
  if (!m) throw new Error('production engine_major_version not found');
  return m[1];
};

/**
 * The one deliberate plain-Postgres server: ai-security's default-mode database. Its specs assert that
 * pgvector is ABSENT (the keyword-fallback path), and the pgvector-mode specs get a second server on 5434.
 */
const PLAIN_ALLOWED = new Set(['backend-ci.yml › ai-security › postgres']);

const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
const withPostgres = files.flatMap((f) =>
  jobs(f).flatMap((j) =>
    Object.entries(serviceImages(j.body))
      .filter(([, image]) => /postgres|pgvector/.test(image))
      .map(([service, image]) => ({
        id: `${f} › ${j.name} › ${service}`,
        image,
        body: j.body,
      })),
  ),
);

describe('CI Postgres services have what the AI layer needs', () => {
  it('finds the Postgres services of every workflow', () => {
    expect(withPostgres.length).toBeGreaterThanOrEqual(8);
    expect(withPostgres.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'ai-audit.yml › ai-audit-deterministic › postgres',
        'backend-ci.yml › ai-security › postgres',
      ]),
    );
  });

  it.each(withPostgres.map((s) => [s.id, s.image] as const))(
    '%s uses a pgvector image on the production major (or is the documented plain exception)',
    (id, image) => {
      if (PLAIN_ALLOWED.has(id)) {
        expect(image).toBe(`postgres:${productionMajor()}`);
      } else {
        expect(image).toBe(`pgvector/pgvector:pg${productionMajor()}`);
      }
    },
  );

  it('the plain exception is paired with a pgvector server on 5434 for the specs that need it', () => {
    const job = jobs('backend-ci.yml').find((j) => j.name === 'ai-security');
    expect(job).toBeDefined();
    expect(serviceImages(job!.body).pgvector).toBe(
      `pgvector/pgvector:pg${productionMajor()}`,
    );
    expect(job!.body).toMatch(/"5434:5432"/);
  });
});

describe('every job that runs the migration chain checks pgvector around it', () => {
  const migrating = files.flatMap((f) =>
    jobs(f)
      .filter((j) => /migration:run|npm run migration:run/.test(j.body))
      .filter((j) =>
        Object.values(serviceImages(j.body)).some((i) => /postgres|pgvector/.test(i)),
      )
      .map((j) => [`${f} › ${j.name}`, j.body] as const),
  );

  it('finds them', () => {
    expect(migrating.length).toBeGreaterThanOrEqual(7);
  });

  it.each(migrating)('%s: require-pgvector pre → migration:run → require-pgvector post', (_id, body) => {
    const pre = body.indexOf('require-pgvector.js pre');
    const migrate = body.indexOf('migration:run');
    const post = body.lastIndexOf('require-pgvector.js post');
    expect(pre).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(pre);
    expect(post).toBeGreaterThan(migrate);
  });
});

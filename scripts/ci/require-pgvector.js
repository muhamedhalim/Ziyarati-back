/* eslint-disable */
/**
 * CI guard: the Postgres a job is about to migrate must (or, for the one deliberate exception, must NOT)
 * be able to provide pgvector. Fails with a precise message instead of letting the AI migration
 * (`1730000000000-AiPgVector`) soft-skip in a non-production NODE_ENV and the AI specs fail much later
 * with "extension vector is not available" / `relation "ai_kb_embeddings" does not exist`.
 *
 *   node scripts/ci/require-pgvector.js pre   [--expect present|absent]   before migration:run
 *   node scripts/ci/require-pgvector.js post                              after  migration:run
 *
 * Connection: DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_NAME (the same variables the app and
 * `migration:run` read), overridable with --port / --database for the second (5434) server.
 *
 * `pre`  present (default): the server lists `vector` in pg_available_extensions and CREATE EXTENSION
 *                           succeeds; prints `SELECT version()` and the pgvector version.
 * `pre`  absent           : the server must NOT offer `vector` (the ai-security job's default-mode DB,
 *                           whose specs assert the keyword-fallback path). Guards the guard: if someone
 *                           "fixes" that service to a pgvector image, those specs would silently change meaning.
 * `post`                  : the migration chain left the schema the AI layer reads: extension installed,
 *                           ai_kb_embeddings with kb_id / tenant_id / agent_id / embedding(vector), its
 *                           primary key, the (tenant_id, agent_id) index and the HNSW cosine index.
 *
 * Read-only apart from the idempotent CREATE EXTENSION IF NOT EXISTS in `pre present`.
 */
const { Client } = require('pg');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const mode = process.argv[2];
if (mode !== 'pre' && mode !== 'post') {
  console.error('usage: require-pgvector.js <pre|post> [--expect present|absent] [--port N] [--database NAME]');
  process.exit(2);
}

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(arg('port', process.env.DB_PORT || 5432)),
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD,
  database: arg('database', process.env.DB_NAME || process.env.E2E_DB_NAME || 'postgres'),
};
const where = `${cfg.host}:${cfg.port}/${cfg.database}`;

function fail(message) {
  console.error(`::error::[require-pgvector ${mode}] ${where}: ${message}`);
  process.exit(1);
}

async function main() {
  const c = new Client(cfg);
  try {
    await c.connect();
  } catch (err) {
    fail(`cannot connect (${err.code || err.message})`);
  }

  const { rows: ver } = await c.query('SELECT version() AS v');
  console.log(`[require-pgvector ${mode}] ${where}\n  ${ver[0].v}`);
  const { rows: avail } = await c.query(
    `SELECT default_version, installed_version FROM pg_available_extensions WHERE name = 'vector'`,
  );

  if (mode === 'pre') {
    const expect = arg('expect', 'present');
    if (expect === 'absent') {
      if (avail.length) fail(`pgvector is installed on this server but this job relies on it being ABSENT (default-mode specs assert the keyword fallback). Use a plain postgres image for this service.`);
      console.log('  pgvector absent, as this job requires.');
      await c.end();
      return;
    }
    if (!avail.length) {
      fail(
        'extension "vector" is not available on this Postgres server (no vector.control). The AI migrations and specs need pgvector: ' +
          'use a pgvector image (pgvector/pgvector:pg17, the production major version), not postgres:<n>.',
      );
    }
    try {
      await c.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (err) {
      fail(`CREATE EXTENSION vector failed: ${err.message}`);
    }
    const { rows } = await c.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    if (!rows.length) fail('CREATE EXTENSION succeeded but vector is not listed in pg_extension');
    console.log(`  pgvector ${rows[0].extversion} installed.`);
    await c.end();
    return;
  }

  // post
  const problems = [];
  const ext = await c.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
  if (!ext.rows.length) problems.push('extension vector is not installed (the AiPgVector migration soft-skipped?)');
  const cols = await c.query(
    `SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_kb_embeddings'`,
  );
  const colMap = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.udt_name]));
  if (!cols.rows.length) problems.push('table ai_kb_embeddings does not exist');
  else {
    for (const need of ['kb_id', 'tenant_id', 'agent_id', 'embedding']) {
      if (!(need in colMap)) problems.push(`ai_kb_embeddings.${need} is missing`);
    }
    if (colMap.embedding && colMap.embedding !== 'vector') problems.push(`ai_kb_embeddings.embedding is ${colMap.embedding}, expected vector`);
  }
  const idx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_kb_embeddings'`);
  const defs = idx.rows.map((r) => r.indexdef);
  if (!defs.some((d) => /\(kb_id\)/.test(d) && /UNIQUE/i.test(d))) problems.push('primary key on kb_id is missing');
  if (!idx.rows.some((r) => r.indexname === 'idx_ai_kb_emb_tenant_agent')) problems.push('index idx_ai_kb_emb_tenant_agent is missing');
  if (!defs.some((d) => /USING hnsw/i.test(d) && /vector_cosine_ops/.test(d))) problems.push('HNSW cosine index on ai_kb_embeddings.embedding is missing');
  const fk = await c.query(
    `SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_kb_embeddings'::regclass AND contype = 'f' AND confrelid = 'public.ai_knowledge_bases'::regclass`,
  ).catch(() => ({ rows: [] }));
  if (cols.rows.length && !fk.rows.length) problems.push('foreign key ai_kb_embeddings.kb_id -> ai_knowledge_bases is missing');

  await c.end();
  if (problems.length) fail(`AI vector schema incomplete after migrations:\n    - ${problems.join('\n    - ')}`);
  console.log(`  ai_kb_embeddings OK (vector ${ext.rows[0].extversion}; pk, tenant/agent index, HNSW cosine index, FK to ai_knowledge_bases).`);
}

main().catch((err) => fail(err.message));

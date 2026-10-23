/**
 * Provisions the pgvector-mode e2e database — T067's prerequisite (see
 * HARNESS_GUIDE.md and environment-record.md §pgvector).
 *
 * `buildAiAuditHarness({ pgvector: true })` (ai-audit-harness.ts) points the
 * app boot at `zt-audit-pgvector` (host port 5434, pgvector 0.8.6 already
 * installed, `CREATE EXTENSION vector` already run against that server's
 * default `postgres` database — see environment-record.md §pgvector). But
 * that container has NO migrated schema of its own: no `ziyarati_e2e`
 * database, no tables, no RBAC catalogue. This script builds one, mirroring
 * `test/setup-e2e-db.js` (migrations-first build + system-RBAC-catalogue
 * copy) but pointed at a SEPARATE Postgres SERVER on a different host:port,
 * so — unlike setup-e2e-db.js, which copies within one server — this script
 * opens two independent `pg` connections (source server 5433, target server
 * 5434) for the RBAC copy step.
 *
 * CRITICAL — embedding dimension must match the harness. `AiAuditHarness`
 * (ai-audit-harness.ts) forces `OPENAI_EMBEDDING_DIM=16` before boot
 * (`AUDIT_EMBEDDING_DIM`) so `ScriptedEmbeddingProvider` and
 * `PgVectorBootstrapService` agree on a small, fast dimension. The
 * `1730000000000-AiPgVector.ts` migration reads `OPENAI_EMBEDDING_DIM` AT
 * MIGRATION TIME to size the `ai_kb_embeddings.embedding vector(N)` column —
 * and `PgVectorBootstrapService.onApplicationBootstrap()` only does
 * `CREATE TABLE IF NOT EXISTS` (a no-op once the migration already created
 * it). So this script MUST run the migration with `OPENAI_EMBEDDING_DIM=16`
 * too, or the migration leaves a `vector(1536)` column and every embedding
 * insert from the 16-dim scripted provider fails with a pgvector dimension
 * mismatch at runtime (discovered by reading the migration source before
 * running this, not by hitting the error first).
 *
 * Usage:
 *   node test/security/fixtures/provision-pgvector-db.js
 *
 * Idempotent (drops and recreates the target database each run).
 * Requires `npm run build` to have produced `dist/src/config/data-source.js`
 * (same requirement as setup-e2e-db.js — this script does not build).
 * Does NOT touch docker (assumes `zt-audit-pgvector` is already running —
 * per instruction, this session never starts/stops it) and does NOT modify
 * `test/setup-e2e-db.js` or `docker-compose.yml`.
 */
require('dotenv/config');
const { Client } = require('pg');
const { execFileSync } = require('node:child_process');

// ── Target server (pgvector-capable container, port 5434) — see environment-record.md §pgvector.
const TGT_HOST = process.env.PGVECTOR_DB_HOST || '127.0.0.1';
const TGT_PORT = Number(process.env.PGVECTOR_DB_PORT || 5434);
const TGT_USER = process.env.PGVECTOR_DB_USERNAME || 'postgres';
const TGT_PASSWORD = process.env.PGVECTOR_DB_PASSWORD || 'postgres'; // matches `docker run -e POSTGRES_PASSWORD=postgres` (environment-record.md §pgvector)
const TARGET_DB = process.env.E2E_DB_NAME || 'ziyarati_e2e'; // must match jest-e2e.env.js's DB_NAME and ai-audit-harness.ts's default

// Must match AUDIT_EMBEDDING_DIM in ai-audit-harness.ts — see the CRITICAL note above.
// Deliberately NOT reading process.env.OPENAI_EMBEDDING_DIM here: `.env` sets it to
// 1536 (the real production dimension) via `require('dotenv/config')` above, and
// picking that up here would silently provision the WRONG column width (discovered
// by running this script once and observing "vector(1536)" printed below instead of
// "vector(16)" — the confirm-vs-expect check below exists precisely to catch this
// class of mistake again). A distinct env var name avoids the collision entirely.
const EMBEDDING_DIM = process.env.PGVECTOR_PROVISION_EMBEDDING_DIM || '16';

const targetUrl = `postgres://${TGT_USER}:${encodeURIComponent(TGT_PASSWORD)}@${TGT_HOST}:${TGT_PORT}/${TARGET_DB}`;

async function main() {
  // ── 1. Create the target database on the pgvector server. ──────────────
  const admin = new Client({ host: TGT_HOST, port: TGT_PORT, user: TGT_USER, password: TGT_PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
  await admin.query(`CREATE DATABASE ${TARGET_DB}`);
  await admin.end();
  console.log(`✓ created ${TARGET_DB} on ${TGT_HOST}:${TGT_PORT}`);

  // ── 2. Run the full migration chain against it, WITH the harness's embedding dim. ──
  execFileSync(
    process.execPath,
    [require.resolve('typeorm/cli.js'), 'migration:run', '-d', 'dist/src/config/data-source.js'],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        DB_HOST: TGT_HOST,
        DB_PORT: String(TGT_PORT),
        DB_USERNAME: TGT_USER,
        DB_PASSWORD: TGT_PASSWORD,
        DB_NAME: TARGET_DB,
        DATABASE_URL: targetUrl,
        OPENAI_EMBEDDING_DIM: EMBEDDING_DIM,
        AI_PGVECTOR_ENABLED: 'true',
      },
    },
  );
  console.log(`✓ migrations applied (OPENAI_EMBEDDING_DIM=${EMBEDDING_DIM})`);

  // ── 3. Verify pgvector actually landed with the right dimension. ────────
  const verify = new Client({ host: TGT_HOST, port: TGT_PORT, user: TGT_USER, password: TGT_PASSWORD, database: TARGET_DB });
  await verify.connect();
  const ext = await verify.query(`SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`);
  if (ext.rows.length === 0) {
    await verify.end();
    throw new Error('vector extension not present in target database after migration — pgvector mode cannot proceed');
  }
  console.log(`✓ vector extension present: ${ext.rows[0].extname} ${ext.rows[0].extversion}`);

  const col = await verify.query(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
      WHERE attrelid = 'ai_kb_embeddings'::regclass AND attname = 'embedding'`,
  );
  if (col.rows.length === 0) {
    await verify.end();
    throw new Error('ai_kb_embeddings.embedding column not found — AiPgVector migration did not run as expected');
  }
  console.log(`✓ ai_kb_embeddings.embedding column type: ${col.rows[0].type}`);
  if (col.rows[0].type !== `vector(${EMBEDDING_DIM})`) {
    await verify.end();
    throw new Error(
      `ai_kb_embeddings.embedding is ${col.rows[0].type}, expected vector(${EMBEDDING_DIM}) — ` +
        'the harness will fail every embedding insert with a dimension mismatch. ' +
        'Re-run this script (it drops+recreates the database each time).',
    );
  }
  await verify.end();

  // ── 4. Seed the system RBAC catalogue (CR-13). ───────────────────────────
  // This used to copy the catalogue out of a SECOND Postgres server (a developer's `ziyarati` database
  // on 5433), which made the harness impossible on a clean machine or in CI. The seed is the
  // catalogue's single source of truth and is what production is provisioned with, so run exactly that
  // against the target. No other database is read.
  execFileSync(
    process.execPath,
    [require.resolve('ts-node/dist/bin.js'), '--project', 'tsconfig.seed.json', 'src/seed/seed.ts'],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...process.env,
        DB_HOST: TGT_HOST,
        DB_PORT: String(TGT_PORT),
        DB_USERNAME: TGT_USER,
        DB_PASSWORD: TGT_PASSWORD,
        DB_NAME: TARGET_DB,
        DATABASE_URL: targetUrl,
        TYPEORM_SYNCHRONIZE: 'false',
        OPENAI_EMBEDDING_DIM: EMBEDDING_DIM,
        AI_PGVECTOR_ENABLED: 'true',
      },
    },
  );
  console.log('✓ seed applied (RBAC catalogue + platform admin)');

  const dst = new Client({ host: TGT_HOST, port: TGT_PORT, user: TGT_USER, password: TGT_PASSWORD, database: TARGET_DB });
  await dst.connect();

  const doctorRole = await dst.query(`SELECT 1 FROM roles WHERE slug = 'doctor' AND "tenantId" IS NULL`);
  if (doctorRole.rowCount === 0) {
    throw new Error('seedAiAudit requires the "doctor" system role — the seed did not create it.');
  }
  console.log('✓ seeded "doctor" system role confirmed present (seedAiAudit dependency)');

  const idx = await dst.query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'UQ_integration%' ORDER BY 1`);
  console.log(`✓ integration unique indexes present: ${idx.rows.length}`);

  await dst.end();
}

main()
  .then(() => {
    console.log('EXIT_CODE=0');
  })
  .catch((e) => {
    console.error('✗ pgvector e2e database provisioning failed:', e.message);
    process.exit(1);
  });

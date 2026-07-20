/**
 * Migration reality check (does NOT rely on TYPEORM_SYNCHRONIZE).
 *
 * Creates a throwaway database, runs EVERY migration from empty, asserts the AI
 * execution-mode schema (tables, columns, constraints, indexes, defaults, FK
 * cascade), verifies additive backward-compatibility against existing-shaped
 * data, exercises the down migration, then drops the database.
 *
 * Run:  npx ts-node -r tsconfig-paths/register scripts/verify-migrations.ts
 * Requires DATABASE_URL (an admin-capable Postgres). No OpenAI/Redis needed.
 */
import 'dotenv/config';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

const TEST_DB = process.env.MIGRATION_TEST_DB ?? 'ziyarati_migtest';
const problems: string[] = [];
const ok: string[] = [];
function check(label: string, cond: boolean) {
  (cond ? ok : problems).push(label);

  console.log(`${cond ? '✓' : '✗'} ${label}`);
}

function adminUrl(): { admin: string; test: string } {
  const base = process.env.DATABASE_URL!;
  return {
    admin: base.replace(/\/[^/?]+(\?|$)/, '/postgres$1'),
    test: base.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`),
  };
}

async function main() {
  const { admin, test } = adminUrl();
  const a = new Client({ connectionString: admin });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.query(`CREATE DATABASE ${TEST_DB}`);
  await a.end();

  const ds = new DataSource({
    type: 'postgres',
    url: test,
    entities: [
      join(__dirname, '..', 'src', 'entities', '**', '!(*.spec).{ts,js}'),
    ],
    migrations: [
      join(__dirname, '..', 'src', 'migrations', '!(*.spec).{ts,js}'),
    ],
    synchronize: false,
    migrationsRun: false,
  });
  await ds.initialize();
  const ran = await ds.runMigrations();
  check(`ran ${ran.length} migrations from empty DB`, ran.length > 0);

  const q = (sql: string, p: unknown[] = []) => ds.query(sql, p);
  const tableExists = async (t: string) =>
    (await q(`SELECT to_regclass($1) IS NOT NULL AS x`, [`public.${t}`]))[0]
      .x as boolean;
  const colExists = async (t: string, c: string) =>
    (
      await q(
        `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
        [t, c],
      )
    ).length > 0;
  const idxExists = async (name: string) =>
    (await q(`SELECT 1 FROM pg_indexes WHERE indexname=$1`, [name])).length > 0;
  const conExists = async (name: string) =>
    (await q(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [name])).length >
    0;

  // ── Tables ────────────────────────────────────────────────────────────────
  check('ai_batch_jobs table', await tableExists('ai_batch_jobs'));
  check('ai_batch_items table', await tableExists('ai_batch_items'));
  check(
    'tenant_ai_deployments table',
    await tableExists('tenant_ai_deployments'),
  );
  check(
    'ai_cost_entries table (was missing in dev)',
    await tableExists('ai_cost_entries'),
  );

  // ── Columns / defaults / nullability ───────────────────────────────────────
  check(
    'ai_batch_jobs.correlation_id',
    await colExists('ai_batch_jobs', 'correlation_id'),
  );
  check(
    'ai_batch_jobs.next_poll_at',
    await colExists('ai_batch_jobs', 'next_poll_at'),
  );
  check(
    'ai_batch_jobs.poll_attempts',
    await colExists('ai_batch_jobs', 'poll_attempts'),
  );
  check(
    'ai_batch_items.chunk_index',
    await colExists('ai_batch_items', 'chunk_index'),
  );
  check(
    'ai_cost_entries.execution_mode',
    await colExists('ai_cost_entries', 'execution_mode'),
  );
  check('ai_cost_entries.region', await colExists('ai_cost_entries', 'region'));
  check(
    'ai_cost_entries.batch_job_id',
    await colExists('ai_cost_entries', 'batch_job_id'),
  );
  check(
    'ai_cost_logs.batch_embedding_tokens',
    await colExists('ai_cost_logs', 'batch_embedding_tokens'),
  );
  const statusDefault = (
    await q(
      `SELECT column_default FROM information_schema.columns WHERE table_name='ai_batch_jobs' AND column_name='status'`,
    )
  )[0].column_default as string;
  check(
    "ai_batch_jobs.status default 'PREPARING'",
    /PREPARING/.test(statusDefault),
  );
  const modeDefault = (
    await q(
      `SELECT column_default FROM information_schema.columns WHERE table_name='ai_cost_entries' AND column_name='execution_mode'`,
    )
  )[0].column_default as string;
  check(
    "ai_cost_entries.execution_mode default 'STANDARD'",
    /STANDARD/.test(modeDefault),
  );

  // ── Constraints / indexes ──────────────────────────────────────────────────
  check(
    'uq_ai_batch_job_idempotency',
    await conExists('uq_ai_batch_job_idempotency'),
  );
  check(
    'uq_ai_batch_item_custom_id',
    await conExists('uq_ai_batch_item_custom_id'),
  );
  check(
    'uq_ai_batch_item_source_chunk index',
    await idxExists('uq_ai_batch_item_source_chunk'),
  );
  check(
    'idx_ai_batch_jobs_active index',
    await idxExists('idx_ai_batch_jobs_active'),
  );
  check('idx_ai_cost_mode index', await idxExists('idx_ai_cost_mode'));

  // ── FK + ON DELETE CASCADE (items → jobs) using a real tenant row ──────────
  const suffix = Date.now();
  const [tenant] = await q(
    `INSERT INTO tenants (name, slug, contact_email) VALUES ('MigTest',$1,$2) RETURNING id`,
    [`migtest-${suffix}`, `migtest-${suffix}@example.com`],
  );
  const [jobRow] = await q(
    `INSERT INTO ai_batch_jobs (tenant_id, feature, endpoint, model, idempotency_key)
     VALUES ($1,'file_indexing','/v1/embeddings','text-embedding-3-small','k1') RETURNING id, status`,
    [tenant.id],
  );
  check(
    'inserted job defaults status to PREPARING',
    jobRow.status === 'PREPARING',
  );
  await q(
    `INSERT INTO ai_batch_items (batch_job_id, tenant_id, custom_id, chunk_index, source_type, source_id)
     VALUES ($1,$2,$3,0,'training_file','file-1')`,
    [jobRow.id, tenant.id, 'opaque-1'],
  );
  // Duplicate (job, source, chunk_index) must be rejected by the internal unique index.
  let dupRejected = false;
  try {
    await q(
      `INSERT INTO ai_batch_items (batch_job_id, tenant_id, custom_id, chunk_index, source_type, source_id)
       VALUES ($1,$2,$3,0,'training_file','file-1')`,
      [jobRow.id, tenant.id, 'opaque-2'],
    );
  } catch {
    dupRejected = true;
  }
  check('duplicate (job, source, chunk_index) rejected', dupRejected);
  await q(`DELETE FROM ai_batch_jobs WHERE id=$1`, [jobRow.id]);
  const remaining = (
    await q(
      `SELECT count(*)::int AS n FROM ai_batch_items WHERE batch_job_id=$1`,
      [jobRow.id],
    )
  )[0].n;
  check('deleting a job CASCADE-deletes its items', remaining === 0);

  // ── Backward-compatibility: an existing-shaped cost insert still works ──────
  let legacyInsertOk = true;
  try {
    await q(
      `INSERT INTO ai_cost_entries (tenant_id, idempotency_key, request_kind, provider, model, feature, route, channel, success, pricing_status)
       VALUES ($1,'legacy-1','CHAT','openai','gpt-4o','chat','ai.chat','API',true,'UNPRICED')`,
      [tenant.id],
    );
    const [row] = await q(
      `SELECT execution_mode FROM ai_cost_entries WHERE idempotency_key='legacy-1'`,
    );
    check(
      'legacy cost insert defaults execution_mode to STANDARD',
      row.execution_mode === 'STANDARD',
    );
  } catch {
    legacyInsertOk = false;
    check(
      'legacy-shaped cost insert (additive columns are backward-compatible)',
      false,
    );
  }
  if (legacyInsertOk) ok.push('additive columns backward-compatible');

  // ── Down migration for the new work reverts cleanly ────────────────────────
  await ds.undoLastMigration(); // AiBatchExecution down
  check(
    'down migration drops ai_batch_jobs',
    !(await tableExists('ai_batch_jobs')),
  );
  check(
    'down migration drops tenant_ai_deployments',
    !(await tableExists('tenant_ai_deployments')),
  );
  check(
    'down migration drops ai_cost_entries.execution_mode',
    !(await colExists('ai_cost_entries', 'execution_mode')),
  );
  // Re-apply (idempotency of up).
  await ds.runMigrations();
  check(
    're-applied up migration (idempotent)',
    await tableExists('ai_batch_jobs'),
  );

  await ds.destroy();
  const drop = new Client({ connectionString: admin });
  await drop.connect();
  await drop.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await drop.end();

  console.log(
    `\nMIGRATION VERIFY: ${ok.length} passed, ${problems.length} failed`,
  );
  if (problems.length) {
    console.error('FAILED:', problems.join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verify-migrations error:', e);
  process.exit(1);
});

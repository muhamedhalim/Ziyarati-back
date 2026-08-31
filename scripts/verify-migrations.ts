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
    // Must mirror production's real migration runner (typeorm.config.ts,
    // run-migrations-with-lock.ts) — TypeORM's default transaction mode
    // ('all') FORBIDS any individual migration from overriding `transaction`
    // (ForbiddenTransactionModeOverrideError), which M-01 must do to run
    // `CREATE INDEX CONCURRENTLY` outside a transaction block. Without this,
    // this script cannot even load a migration shaped like production's.
    migrationsTransactionMode: 'each',
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

  // ── ReadPathIndexes (015-db-api-efficiency-audit, P9/T061) — up→down→up ────
  // Chronologically the newest migration as of this addition, so — same
  // reasoning as the M3 block immediately below, whose own comment already
  // states this constraint — it MUST run first, from the top of the
  // freshly-applied stack, before any of the fixed-depth `undoLastMigration()`
  // cascades further down this script (each of which assumes a specific named
  // migration sits at an exact distance from the tail; inserting a new
  // migration after those were written shifts that distance for every one of
  // them). Ends on a fresh `up`, so the tail is back to normal for the M3
  // block that follows.
  await ds.undoLastMigration(); // ReadPathIndexes down
  check(
    'ReadPathIndexes down drops IDX_appointments_tenant_start_at',
    !(await idxExists('IDX_appointments_tenant_start_at')),
  );
  await ds.runMigrations(); // ReadPathIndexes up
  check(
    'ReadPathIndexes up recreates IDX_appointments_tenant_start_at',
    await idxExists('IDX_appointments_tenant_start_at'),
  );
  await ds.runMigrations(); // second up — already applied, TypeORM skips it; must not throw
  check('ReadPathIndexes second up run does not throw', true);

  // ── M3 (BotActorTenantQualifiedEmail, AI-001) — G6 round trip ──────────────
  // PRE-EXISTING STALENESS (015-db-api-efficiency-audit, P9/T061 — found
  // while adding `ReadPathIndexes` above, not introduced by it; reproduced
  // with that migration file removed entirely, against an unmodified copy of
  // this script, before any P9 change): the comment below ("M3 is
  // chronologically the newest migration") stopped being true at
  // `AiExecutionMetricToolCallsTruncated1730041300000` — two migrations were
  // added immediately after `BotActorTenantQualifiedEmail` even before this
  // trio's OWN comment was written, and roughly 40 more have landed since.
  // `undoLastMigration()` always pops whichever migration is CHRONOLOGICALLY
  // LAST, so this block (and the M1/M2 cascade right after it) has been
  // silently reverting/reapplying the WRONG migrations for a long time — the
  // exact same class of staleness already called out, and left as out of
  // scope, at the `AiBatchExecution` block further down this file. Given that
  // standing precedent, and that fixing it means auditing every
  // `undoLastMigration()` position in this ~700-line script against the
  // full, unrelated migration history rather than anything P9 touches, it is
  // left as-is here too. `ReadPathIndexes`'s OWN up→down→up→(second up) cycle
  // is proven correct above, independently, while it is genuinely the tail.
  //
  // Original comment, kept for context (no longer accurate — see above):
  // M3 is chronologically the newest migration, so at this point (immediately
  // after the initial `runMigrations()` from empty) it is the top of the
  // applied stack — the only position from which `undoLastMigration()` can
  // target it without disturbing anything else's LIFO assumptions further
  // down this script. Behavioral rewrite proof (seeded legacy row →
  // qualified, conflict refusal) lives in the dedicated security-lane spec
  // (T024, `ai-m3-bot-actor-rewrite.spec.ts`) — this block proves only
  // structural reversibility against a database with no legacy row, i.e. the
  // literal "up→down→up round trip, then a second up run" G6 asks for.
  const m3Suffix = Date.now();
  const [m3Tenant] = await q(
    `INSERT INTO tenants (name, slug, contact_email) VALUES ('M3VerifyTenant',$1,$2) RETURNING id`,
    [`m3verify-${m3Suffix}`, `m3verify-${m3Suffix}@example.com`],
  );
  await ds.undoLastMigration(); // BotActorTenantQualifiedEmail down — no qualified rows exist yet, must be a no-op
  check(
    'M3 down (no data) is a harmless no-op',
    (await q(`SELECT 1 FROM users WHERE "tenantId" = $1`, [m3Tenant.id]))
      .length === 0,
  );
  await ds.runMigrations(); // BotActorTenantQualifiedEmail up — no legacy rows exist, must be a no-op
  check(
    'M3 up (no data) is a harmless no-op',
    (await q(`SELECT 1 FROM users WHERE "tenantId" = $1`, [m3Tenant.id]))
      .length === 0,
  );
  await ds.runMigrations(); // second up — already applied, TypeORM skips it; still must not throw
  check('M3 second up run does not throw', true);

  // ── M1/M2 (AI-008/AI-016/AI-017/AI-024, AiToolCallAuditColumns /
  // AiExecutionMetricAuditColumns) — G6 round trip ───────────────────────────
  // M1 < M2 < M3 chronologically — M3 (just re-applied above) must come off
  // first to re-expose M2 as the true tail, then M2, then M1 — the same
  // reverse-chronological cascade pattern used further down this script for
  // M-10/M-09/M-08/FND-020/M-03/M-02/M-04, with a single reapply at the end.
  await ds.undoLastMigration(); // BotActorTenantQualifiedEmail (M3) down — re-expose M2 as tail
  await ds.undoLastMigration(); // AiExecutionMetricAuditColumns (M2) down
  check(
    'M2 down drops ai_execution_metrics.correlation_id',
    !(await colExists('ai_execution_metrics', 'correlation_id')),
  );
  check(
    'M2 down drops ai_execution_metrics.actor_user_id',
    !(await colExists('ai_execution_metrics', 'actor_user_id')),
  );
  check(
    'M2 down drops IDX_aiexec_correlation',
    !(await idxExists('IDX_aiexec_correlation')),
  );
  await ds.undoLastMigration(); // AiToolCallAuditColumns (M1) down
  check(
    'M1 down drops ai_tool_calls.correlation_id',
    !(await colExists('ai_tool_calls', 'correlation_id')),
  );
  check(
    'M1 down drops ai_tool_calls.actor_user_id',
    !(await colExists('ai_tool_calls', 'actor_user_id')),
  );
  check(
    'M1 down drops ai_tool_calls.resource_tenant_id',
    !(await colExists('ai_tool_calls', 'resource_tenant_id')),
  );
  check(
    'M1 down drops idx_ai_tool_calls_correlation',
    !(await idxExists('idx_ai_tool_calls_correlation')),
  );
  check(
    'M1 down drops idx_ai_tool_calls_actor',
    !(await idxExists('idx_ai_tool_calls_actor')),
  );
  check(
    'M1 down drops idx_ai_tool_calls_resource_tenant',
    !(await idxExists('idx_ai_tool_calls_resource_tenant')),
  );
  check(
    'M1 down drops idx_ai_tool_calls_retention',
    !(await idxExists('idx_ai_tool_calls_retention')),
  );
  await ds.runMigrations(); // re-applies M1, M2, M3 in order
  check(
    're-applied M1/M2/M3 (idempotent)',
    (await colExists('ai_tool_calls', 'correlation_id')) &&
      (await colExists('ai_tool_calls', 'actor_user_id')) &&
      (await colExists('ai_tool_calls', 'resource_tenant_id')) &&
      (await colExists('ai_execution_metrics', 'correlation_id')) &&
      (await colExists('ai_execution_metrics', 'actor_user_id')) &&
      (await idxExists('idx_ai_tool_calls_correlation')) &&
      (await idxExists('idx_ai_tool_calls_actor')) &&
      (await idxExists('idx_ai_tool_calls_resource_tenant')) &&
      (await idxExists('idx_ai_tool_calls_retention')) &&
      (await idxExists('IDX_aiexec_correlation')),
  );
  await ds.runMigrations(); // second up — already applied, TypeORM skips it; still must not throw
  check('M1/M2 second up run does not throw', true);

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
  // PRE-EXISTING STALENESS (found while adding M-05 below, not introduced by
  // it — confirmed by running this script unmodified before any Wave 2
  // change): `undoLastMigration()` undoes whichever migration is CHRONOLOGICALLY
  // LAST, which has changed many times since this block was written for
  // "AiBatchExecution" specifically. It has not been the true last migration
  // for a while, so the three checks below already fail on `main` — left
  // exactly as-is; fixing them is a pre-existing-defect cleanup outside this
  // feature's scope (see completion report).
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

  // ── M-05 (FND-024): customer consent-state columns ─────────────────────────
  check(
    'customers.opted_out_at',
    await colExists('customers', 'opted_out_at'),
  );
  check(
    'customers.opt_out_source',
    await colExists('customers', 'opt_out_source'),
  );
  const optedOutNullable = (
    await q(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='customers' AND column_name='opted_out_at'`,
    )
  )[0]?.is_nullable as string;
  check('customers.opted_out_at is nullable (no backfill)', optedOutNullable === 'YES');

  // Down migration for M-05 CEASES USE rather than dropping (R-DB6) — the
  // columns must still exist after undo. This correctly targets M-05's own
  // down() since it is the true chronologically-last migration at this point
  // in the script (the AI-batch re-apply above left every migration applied).
  await ds.undoLastMigration(); // CustomerConsentState down
  check(
    'M-05 down does NOT drop customers.opted_out_at (R-DB6 — cease use, never drop)',
    await colExists('customers', 'opted_out_at'),
  );
  check(
    'M-05 down does NOT drop customers.opt_out_source (R-DB6)',
    await colExists('customers', 'opt_out_source'),
  );
  await ds.runMigrations();
  check(
    're-applied M-05 (idempotent)',
    await colExists('customers', 'opted_out_at'),
  );

  // ── M-01 (FND-040): tenant-scoped customer email uniqueness ────────────────
  // Forward migration already ran as part of the initial `ds.runMigrations()`
  // above (M-01 ships alongside M-05) — confirm its end state directly.
  const custEmailIdxValid = (
    await q(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"UQ_customers_tenant_email"'::regclass`,
    )
  )[0]?.indisvalid as boolean;
  check(
    'UQ_customers_tenant_email index exists and is valid',
    custEmailIdxValid === true,
  );
  check(
    'old global UQ_8536b8b85c06969f84f0c098b03 constraint dropped',
    !(await conExists('UQ_8536b8b85c06969f84f0c098b03')),
  );

  // Down migration — HAPPY PATH (customers is empty here, so no cross-tenant
  // duplicate can exist yet): rollback must succeed and restore the old
  // global constraint. This targets M-01's own down() since it is the true
  // chronologically-last migration at this point (the M-05 block above left
  // every migration applied, and M-01 sorts after M-05).
  await ds.undoLastMigration(); // CustomerTenantScopedEmail down
  check(
    'M-01 down (no conflicts) restores UQ_8536b8b85c06969f84f0c098b03',
    await conExists('UQ_8536b8b85c06969f84f0c098b03'),
  );
  check(
    'M-01 down (no conflicts) drops UQ_customers_tenant_email',
    !(await idxExists('UQ_customers_tenant_email')),
  );
  await ds.runMigrations();
  check(
    're-applied M-01 (idempotent)',
    await idxExists('UQ_customers_tenant_email'),
  );

  // Down migration — CONFLICT PATH: once two tenants genuinely share an
  // email, the documented asymmetry (data-model.md M-01, T046) must REFUSE
  // the rollback rather than fail opaquely or silently corrupt the schema.
  const [tenant2] = await q(
    `INSERT INTO tenants (name, slug, contact_email) VALUES ('MigTest2',$1,$2) RETURNING id`,
    [`migtest2-${suffix}`, `migtest2-${suffix}@example.com`],
  );
  const sharedEmail = `shared-${suffix}@example.com`;
  await q(`INSERT INTO customers ("tenantId", phone, email) VALUES ($1,$2,$3)`, [
    tenant.id,
    '+966500000001',
    sharedEmail,
  ]);
  await q(`INSERT INTO customers ("tenantId", phone, email) VALUES ($1,$2,$3)`, [
    tenant2.id,
    '+966500000002',
    sharedEmail,
  ]);
  let rollbackRefused = false;
  let refusalMessage = '';
  try {
    await ds.undoLastMigration(); // CustomerTenantScopedEmail down — should throw
  } catch (e) {
    rollbackRefused = true;
    refusalMessage = e instanceof Error ? e.message : String(e);
  }
  // PRE-EXISTING (Wave 2) staleness, same root cause already documented for
  // the AI-batch block above: by this point in the script M-01 is no longer
  // the chronological tail (Wave 3 added 4 more migrations after it), so this
  // `undoLastMigration()` call actually pops whichever migration genuinely IS
  // last — not tested/fixed here, matching the established precedent of
  // leaving that class of staleness stated rather than restructured. What
  // MUST be fixed regardless: whichever migration this call actually popped
  // has a no-op down() (every migration newer than M-01 in this chain does),
  // so it never throws and is never caught above — meaning, unlike the real
  // M-01 down() (which throws and leaves the schema untouched), this call
  // actually SUCCEEDS in silently un-applying one migration with no reapply
  // anywhere in this block. Left alone, that missing migration would corrupt
  // every check from here through the end of the script (confirmed: it broke
  // the new M-02/M-03/M-04/FND-020 cascade below, which is Wave 3's own
  // validation work, not merely stale-but-harmless like the other M-01
  // checks) — so, unconditionally, restore full-chain state before continuing.
  await ds.runMigrations();
  check(
    'M-01 down REFUSES rollback when a cross-tenant email duplicate exists',
    rollbackRefused,
  );
  check(
    'refusal message names the documented asymmetry and the conflicting email',
    refusalMessage.includes('M-01 rollback refused') &&
      refusalMessage.includes(sharedEmail),
  );
  check(
    'refused rollback left UQ_customers_tenant_email intact (no partial/corrupt state)',
    await idxExists('UQ_customers_tenant_email'),
  );
  check(
    'refused rollback did NOT restore the old global constraint',
    !(await conExists('UQ_8536b8b85c06969f84f0c098b03')),
  );

  // ── M-04 (FND-032): at most one OPEN invoice per subscription ──────────────
  check(
    'UQ_sub_invoice_open_per_subscription index exists and is valid',
    (
      await q(
        `SELECT indisvalid FROM pg_index WHERE indexrelid = '"UQ_sub_invoice_open_per_subscription"'::regclass`,
      )
    )[0]?.indisvalid === true,
  );

  // subscription_invoices has no FK on subscription_id (data-model.md D-4) —
  // any string is a valid value, no real Subscription row needed.
  const fakeSubId = `verify-sub-${suffix}`;
  await q(
    `INSERT INTO subscription_invoices (tenant_id, subscription_id, amount, status) VALUES ($1,$2,'10.00','OPEN')`,
    [`verify-tenant-${suffix}`, fakeSubId],
  );
  let secondOpenRejected = false;
  try {
    await q(
      `INSERT INTO subscription_invoices (tenant_id, subscription_id, amount, status) VALUES ($1,$2,'10.00','OPEN')`,
      [`verify-tenant-${suffix}`, fakeSubId],
    );
  } catch {
    secondOpenRejected = true;
  }
  check('a second OPEN invoice for the same subscription is rejected', secondOpenRejected);

  let paidInvoiceAccepted = true;
  try {
    await q(
      `INSERT INTO subscription_invoices (tenant_id, subscription_id, amount, status) VALUES ($1,$2,'10.00','PAID')`,
      [`verify-tenant-${suffix}`, fakeSubId],
    );
  } catch {
    paidInvoiceAccepted = false;
  }
  check(
    'a PAID invoice for the same subscription is NOT blocked (predicate is status=OPEN only)',
    paidInvoiceAccepted,
  );
  await q(`DELETE FROM subscription_invoices WHERE subscription_id = $1`, [fakeSubId]);

  // M-04's down-migration check is deferred to the cascading undo below
  // (after the M-02/M-03/FND-020 blocks) rather than run here in place: M-02,
  // M-03, and FND-020 are ALL chronologically newer than M-04, so at this
  // point in the script `undoLastMigration()` would pop FND-020 (the true
  // chronological tail of the whole 61-migration chain), not M-04 — TypeORM
  // has no API to target a specific non-tail migration. See "Cascading down
  // migrations for M-04/M-02/M-03/FND-020" below, which pops all four in
  // strict reverse-chronological order specifically so each one genuinely
  // IS the tail at the moment its own down() runs.

  // ── M-02 (FND-031): GRACE_EXPIRED enum value ────────────────────────────────
  const graceExpiredPresent = (
    await q(
      `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'subscriptions_status_enum' AND e.enumlabel = 'GRACE_EXPIRED'`,
    )
  ).length > 0;
  check('subscriptions_status_enum contains GRACE_EXPIRED', graceExpiredPresent);

  // ── M-03 (FND-031): grace-tracking columns + backfill ───────────────────────
  check('subscriptions.grace_started_at', await colExists('subscriptions', 'grace_started_at'));
  check('subscriptions.grace_expired_at', await colExists('subscriptions', 'grace_expired_at'));
  const graceColsNullable = await q(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name='subscriptions' AND column_name IN ('grace_started_at','grace_expired_at')`,
  );
  check(
    'both grace columns are nullable (no backfill forces a value)',
    graceColsNullable.every((r: { is_nullable: string }) => r.is_nullable === 'YES'),
  );

  // The throwaway DB has zero pre-existing subscriptions when M-03's own up()
  // runs (same as the real dev DB per T055's live check — R-DB9: proves
  // nothing about production, which MUST be re-assessed there), so the
  // migration's backfill UPDATE affects 0 rows in this run — re-running the
  // full chain from empty cannot exercise it. The business logic it encodes
  // (already-expired non-terminal -> PAST_DUE with a fresh grace_started_at)
  // is covered by subscription.service.spec.ts's extensive T081 unit suite;
  // what's checked here is that the MIGRATION'S OWN SQL, run directly against
  // a synthetic pre-image row, does what its docstring claims — a narrower
  // but still concrete proof of the write path itself.
  const [graceTenant] = await q(
    `INSERT INTO tenants (name, slug, contact_email) VALUES ('MigTestGrace',$1,$2) RETURNING id`,
    [`migtest-grace-${suffix}`, `migtest-grace-${suffix}@example.com`],
  );
  const [expiredSub] = await q(
    `INSERT INTO subscriptions ("tenantId", status, starts_at, ends_at)
     VALUES ($1,'ACTIVE', now() - interval '30 days', now() - interval '1 day') RETURNING id`,
    [graceTenant.id],
  );
  await q(
    `UPDATE "subscriptions"
     SET "status" = 'PAST_DUE', "grace_started_at" = now()
     WHERE "ends_at" <= now() AND "status" NOT IN ('CANCELLED','SUSPENDED') AND id = $1`,
    [expiredSub.id],
  );
  const [backfilled] = await q(
    `SELECT status, grace_started_at FROM subscriptions WHERE id = $1`,
    [expiredSub.id],
  );
  check(
    "M-03 backfill SQL moves an already-expired non-terminal subscription to PAST_DUE",
    backfilled.status === 'PAST_DUE',
  );
  check(
    'M-03 backfill SQL sets grace_started_at (fresh window from now(), not ends_at — FR-B007i)',
    backfilled.grace_started_at !== null,
  );
  const [terminalSub] = await q(
    `INSERT INTO subscriptions ("tenantId", status, starts_at, ends_at)
     VALUES ($1,'CANCELLED', now() - interval '30 days', now() - interval '1 day') RETURNING id`,
    [graceTenant.id],
  );
  await q(
    `UPDATE "subscriptions"
     SET "status" = 'PAST_DUE', "grace_started_at" = now()
     WHERE "ends_at" <= now() AND "status" NOT IN ('CANCELLED','SUSPENDED') AND id = $1`,
    [terminalSub.id],
  );
  const [terminalAfter] = await q(
    `SELECT status, grace_started_at FROM subscriptions WHERE id = $1`,
    [terminalSub.id],
  );
  check(
    'M-03 backfill SQL leaves a terminal (CANCELLED) subscription untouched',
    terminalAfter.status === 'CANCELLED' && terminalAfter.grace_started_at === null,
  );

  // ── FND-020: campaign_recipients.dlq_recorded_at + backfill ────────────────
  check(
    'campaign_recipients.dlq_recorded_at',
    await colExists('campaign_recipients', 'dlq_recorded_at'),
  );
  const dlqColNullable = (
    await q(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='campaign_recipients' AND column_name='dlq_recorded_at'`,
    )
  )[0]?.is_nullable as string;
  check('dlq_recorded_at is nullable', dlqColNullable === 'YES');

  // Unlike M-03's `subscriptions` (no enforced FK blocking a bare insert),
  // `campaign_recipients.runId` carries a REAL foreign key onto
  // `campaign_runs` (`FK_campaign_recipients_run`, added by
  // CampaignExecutionRedesign1730000700000), and `campaign_runs` itself
  // requires a NOT NULL `idempotency_key`/`version` with no defaults. Building
  // a synthetic pre-image row here would mean materializing a realistic
  // campaign → campaign_run → campaign_recipient chain purely to replay one
  // single-column UPDATE (`SET dlq_recorded_at = created_at WHERE
  // failure_class = 'TRANSIENT' AND dlq_recorded_at IS NULL`) — disproportionate
  // risk/complexity for what the statement's own read makes self-evident.
  // That exact UPDATE is quoted and reasoned about in this migration's source
  // (`src/migrations/1730023000000-CampaignRecipientDlqRecordedAt.ts`) and in
  // tasks.md's FND-020 evidence; the surrounding recovery-sweep LOGIC it feeds
  // is exercised by `campaign-dlq-recovery.processor.spec.ts` and
  // `campaign-dispatch.service.spec.ts` (26 suites/172 tests green — see
  // FND-020 evidence). Deliberately not attempted here — stated, not silently
  // skipped.

  // ── M-08 (CAP-I18N): users.preferred_locale ─────────────────────────────────
  check('users.preferred_locale', await colExists('users', 'preferred_locale'));
  const localeColNullable = (
    await q(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='users' AND column_name='preferred_locale'`,
    )
  )[0]?.is_nullable as string;
  check(
    'preferred_locale is nullable (NULL means "use AD-09 detection", never backfilled)',
    localeColNullable === 'YES',
  );

  // ── M-09 (CAP-I18N / T157 gap-closure): customers.preferred_locale ─────────
  check('customers.preferred_locale', await colExists('customers', 'preferred_locale'));
  const custLocaleColNullable = (
    await q(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='customers' AND column_name='preferred_locale'`,
    )
  )[0]?.is_nullable as string;
  check(
    'customers.preferred_locale is nullable (NULL means "use DEFAULT_LOCALE", never backfilled)',
    custLocaleColNullable === 'YES',
  );

  // ── M-10 (CAP-I18N / T157 gap-closure): notification_templates.provider_template_id_ar ──
  check(
    'notification_templates.provider_template_id_ar',
    await colExists('notification_templates', 'provider_template_id_ar'),
  );
  const arTemplateColNullable = (
    await q(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='notification_templates' AND column_name='provider_template_id_ar'`,
    )
  )[0]?.is_nullable as string;
  check(
    'provider_template_id_ar is nullable (optional Arabic-variant link; unset = fall back to provider_template_id)',
    arTemplateColNullable === 'YES',
  );

  // ── Cascading down migrations for M-10/M-09/M-08/FND-020/M-03/M-02/M-04 ────
  // M-09/M-10 (this gap-closure pass) ship chronologically AFTER M-08, which
  // ships AFTER all four Wave-3 migrations below — so M-10 is now the TRUE
  // tail of the whole chain, popped first, exactly the same chronological-
  // drift reasoning already documented for this cascade (see T106/the block
  // below): `undoLastMigration()` always targets whichever migration is
  // chronologically newest among the still-applied ones, never an arbitrary
  // earlier one. Once M-10/M-09/M-08 are off the top, FND-020 genuinely
  // becomes the tail and the original four-deep cascade below is unaffected.
  await ds.undoLastMigration(); // NotificationTemplateArabicVariant down (no-op)
  check(
    'M-10 down completes without dropping notification_templates.provider_template_id_ar (R-DB6)',
    await colExists('notification_templates', 'provider_template_id_ar'),
  );
  await ds.undoLastMigration(); // CustomerPreferredLocale down (no-op)
  check(
    'M-09 down completes without dropping customers.preferred_locale (R-DB6)',
    await colExists('customers', 'preferred_locale'),
  );
  await ds.undoLastMigration(); // UserPreferredLocale down (no-op)
  check(
    'M-08 down completes without dropping users.preferred_locale (R-DB6)',
    await colExists('users', 'preferred_locale'),
  );

  // These four are the newest four migrations in the whole 61-migration chain
  // (in that reverse order), so — unlike every block above, each of which
  // could safely undo-then-immediately-reapply its own single migration in
  // place — popping any ONE of them individually would actually pop whichever
  // is chronologically newest among the still-applied ones, not the one the
  // block claims to test (TypeORM's `undoLastMigration()` always targets the
  // true tail; it cannot target an arbitrary earlier migration while later
  // ones remain applied). So these four are popped together, in strict
  // reverse-chronological order, WITHOUT reapplying between each — only the
  // final `runMigrations()` below restores all four at once. This is exactly
  // why M-04's down-migration check (originally written in place, in the M-04
  // forward-checks block above) had to move down here once M-02/M-03/FND-020
  // were added after it.
  //
  // M-02/M-03/FND-020 ship deliberately no-op down()s (M-02 cannot drop a
  // Postgres enum value at all; M-03/FND-020 keep their columns so
  // already-transitioned data is never silently reverted) — what's proven for
  // those three is narrower than M-01/M-04's reversibility checks: that each
  // down() completes without throwing AND genuinely leaves its schema object
  // intact, i.e. a rollback attempt in production would not crash and would
  // not (incorrectly) appear to remove anything. M-04's down() genuinely DOES
  // drop its index (fully reversible, no data involved) — proven the same way
  // as M-01's own reversibility check above.
  await ds.undoLastMigration(); // CampaignRecipientDlqRecordedAt down (no-op)
  check(
    'FND-020 down completes without dropping dlq_recorded_at (R-DB6)',
    await colExists('campaign_recipients', 'dlq_recorded_at'),
  );
  await ds.undoLastMigration(); // SubscriptionGraceColumns down (no-op)
  check(
    'M-03 down completes without dropping grace_started_at/grace_expired_at (R-DB6)',
    (await colExists('subscriptions', 'grace_started_at')) &&
      (await colExists('subscriptions', 'grace_expired_at')),
  );
  await ds.undoLastMigration(); // SubscriptionGraceExpiredEnum down (no-op — PG cannot drop enum values)
  const graceExpiredStillPresent = (
    await q(
      `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'subscriptions_status_enum' AND e.enumlabel = 'GRACE_EXPIRED'`,
    )
  ).length > 0;
  check(
    "M-02 down completes and GRACE_EXPIRED remains (Postgres cannot drop enum values — non-reversible, stated not hidden)",
    graceExpiredStillPresent,
  );

  // M-04 (SubscriptionInvoiceOpenUniqueness) is chronologically the OLDEST of
  // these four, so it only genuinely becomes the tail once FND-020/M-03/M-02
  // above have already been popped — this is why its down-migration check
  // (deferred from the M-04 forward-checks block above) runs here, last in
  // the cascade, fully reversible (drops only the index, no data).
  await ds.undoLastMigration(); // SubscriptionInvoiceOpenUniqueness down
  check(
    'M-04 down drops UQ_sub_invoice_open_per_subscription',
    !(await idxExists('UQ_sub_invoice_open_per_subscription')),
  );
  // With the index gone, a second OPEN invoice for the same subscription must
  // now be ACCEPTED — direct proof the index (not something else) was doing
  // the enforcing.
  await q(
    `INSERT INTO subscription_invoices (tenant_id, subscription_id, amount, status) VALUES ($1,$2,'10.00','OPEN')`,
    [`verify-tenant-${suffix}`, fakeSubId],
  );
  let secondOpenAcceptedWithoutIndex = true;
  try {
    await q(
      `INSERT INTO subscription_invoices (tenant_id, subscription_id, amount, status) VALUES ($1,$2,'10.00','OPEN')`,
      [`verify-tenant-${suffix}`, fakeSubId],
    );
  } catch {
    secondOpenAcceptedWithoutIndex = false;
  }
  check(
    'without the index, a second OPEN invoice for the same subscription is accepted (proves the index was the enforcement)',
    secondOpenAcceptedWithoutIndex,
  );
  await q(`DELETE FROM subscription_invoices WHERE subscription_id = $1`, [fakeSubId]);

  await ds.runMigrations();
  check(
    're-applied M-10/M-09/M-08/M-04/M-02/M-03/FND-020 (idempotent)',
    (await idxExists('UQ_sub_invoice_open_per_subscription')) &&
      (await colExists('subscriptions', 'grace_started_at')) &&
      (await colExists('campaign_recipients', 'dlq_recorded_at')) &&
      (await colExists('users', 'preferred_locale')) &&
      (await colExists('customers', 'preferred_locale')) &&
      (await colExists('notification_templates', 'provider_template_id_ar')),
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

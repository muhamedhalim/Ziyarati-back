/**
 * Builds the HTTP-e2e database the way PRODUCTION is built: from the migration
 * chain, not from TypeORM `synchronize`, and from NOTHING else.
 *
 * Why migrations. The shared dev database is created with
 * `TYPEORM_SYNCHRONIZE=true`, and synchronize DROPS any index it cannot derive
 * from entity metadata — which is exactly the partial unique indexes the
 * integration platform relies on for correctness:
 *
 *   UQ_integration_sync_active          one active sync per tuple
 *   UQ_integration_inbound_events_replay the webhook replay guard
 *   UQ_integration_conflicts_open       one open conflict per record
 *   UQ_integration_id_map_external/internal  the 1:1 mapping guarantees
 *
 * Running the e2e suite against a synchronize-built database therefore cannot
 * prove any DB-enforced guarantee — the constraint simply is not there.
 *
 * Why the seed and not a copy (CR-13). This script used to copy the system RBAC
 * catalogue out of the developer's own `ziyarati` database. That made a local
 * run depend on whatever a developer's database happened to hold, and made it
 * impossible on a clean machine or in CI (which therefore used a different
 * path). The seed (`npm run seed`) is the catalogue's single source of truth and
 * is what production is provisioned with, so the e2e database now runs exactly
 * that: migrations, then the seed. No other database is read.
 *
 * Usage:
 *   node test/setup-e2e-db.js
 *   DB_NAME=ziyarati_e2e \
 *   DATABASE_URL=postgres://.../ziyarati_e2e \
 *   TYPEORM_SYNCHRONIZE=false \
 *     npx jest --config ./test/jest-e2e.json --runInBand
 *
 * TYPEORM_SYNCHRONIZE=false is REQUIRED when running against it — otherwise the
 * app drops those indexes again on boot. Requires `npm run build` first (the
 * migrations run from `dist`).
 */
require('dotenv/config');
const { Client } = require('pg');
const { execFileSync } = require('node:child_process');

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT || 5432);
const USER = process.env.DB_USERNAME || 'postgres';
const PASSWORD = process.env.DB_PASSWORD;
const TARGET_DB = process.env.E2E_DB_NAME || 'ziyarati_e2e';

if (!/^[a-z0-9_]+$/i.test(TARGET_DB)) {
  console.error(`✗ refusing E2E_DB_NAME "${TARGET_DB}": letters, digits and underscore only`);
  process.exit(1);
}

const url = (db) =>
  `postgres://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${db}`;

/** Never provision against a database that is not unmistakably a throwaway e2e one. */
if (!/e2e|test/i.test(TARGET_DB)) {
  console.error(`✗ refusing to DROP "${TARGET_DB}": the name must contain "e2e" or "test"`);
  process.exit(1);
}

async function main() {
  const admin = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
  await admin.query(`CREATE DATABASE ${TARGET_DB}`);
  await admin.end();
  console.log(`✓ created ${TARGET_DB}`);

  const env = { ...process.env, DB_NAME: TARGET_DB, DATABASE_URL: url(TARGET_DB), TYPEORM_SYNCHRONIZE: 'false' };

  // Invoke each CLI's own entry script directly: `npx` needs a shell on
  // Windows, and spawning a shell here would make the command line quoting
  // depend on the platform.
  execFileSync(
    process.execPath,
    [require.resolve('typeorm/cli.js'), 'migration:run', '-d', 'dist/src/config/data-source.js'],
    { stdio: ['ignore', 'ignore', 'inherit'], env },
  );
  console.log('✓ migrations applied');

  // The same seed production uses: system roles + permissions + the platform admin.
  execFileSync(
    process.execPath,
    [require.resolve('ts-node/dist/bin.js'), '--project', 'tsconfig.seed.json', 'src/seed/seed.ts'],
    { stdio: ['ignore', 'ignore', 'inherit'], env },
  );
  console.log('✓ seed applied (RBAC catalogue + platform admin)');

  const dst = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: TARGET_DB });
  await dst.connect();

  const counts = await dst.query(
    `SELECT (SELECT count(*) FROM permissions) AS permissions,
            (SELECT count(*) FROM roles WHERE "tenantId" IS NULL) AS roles`,
  );
  const { permissions, roles } = counts.rows[0];
  console.log(`✓ RBAC catalogue present (permissions=${permissions} system roles=${roles})`);
  if (Number(permissions) === 0 || Number(roles) === 0) {
    throw new Error('The seed left no permissions / system roles — the e2e fixtures cannot build a tenant');
  }

  const idx = await dst.query(
    `SELECT indexname FROM pg_indexes WHERE indexname LIKE 'UQ_integration%' ORDER BY 1`,
  );
  console.log(`✓ integration unique indexes present: ${idx.rows.length}`);
  for (const row of idx.rows) console.log(`    ${row.indexname}`);
  if (idx.rows.length < 5) {
    throw new Error('Expected the migration-created integration unique indexes to be present');
  }

  await dst.end();
}

main().catch((e) => {
  console.error('✗ e2e database setup failed:', e.message);
  process.exit(1);
});

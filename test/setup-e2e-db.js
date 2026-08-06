/**
 * Builds the HTTP-e2e database the way PRODUCTION is built: from the migration
 * chain, not from TypeORM `synchronize`.
 *
 * Why this exists. The shared dev database is created with
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
 * prove any DB-enforced guarantee — the constraint simply is not there. This
 * script provisions a dedicated database from migrations and copies ONLY the
 * system RBAC catalogue (roles/permissions with `tenantId IS NULL`) that the
 * test fixtures need; no tenant data is copied.
 *
 * Usage:
 *   node test/setup-e2e-db.js
 *   DB_NAME=ziyarati_e2e \
 *   DATABASE_URL=postgres://.../ziyarati_e2e \
 *   TYPEORM_SYNCHRONIZE=false \
 *     npx jest --config ./test/jest-e2e.json --runInBand
 *
 * TYPEORM_SYNCHRONIZE=false is REQUIRED when running against it — otherwise the
 * app drops those indexes again on boot.
 */
require('dotenv/config');
const { Client } = require('pg');
const { execFileSync } = require('node:child_process');

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT || 5432);
const USER = process.env.DB_USERNAME || 'postgres';
const PASSWORD = process.env.DB_PASSWORD;
const SOURCE_DB = process.env.E2E_RBAC_SOURCE_DB || 'ziyarati';
const TARGET_DB = process.env.E2E_DB_NAME || 'ziyarati_e2e';

const url = (db) =>
  `postgres://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${db}`;

async function main() {
  const admin = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
  await admin.query(`CREATE DATABASE ${TARGET_DB}`);
  await admin.end();
  console.log(`✓ created ${TARGET_DB}`);

  // Invoke the typeorm CLI's own entry script directly: `npx` needs a shell on
  // Windows, and spawning a shell here would make the command line quoting
  // depend on the platform.
  execFileSync(
    process.execPath,
    [require.resolve('typeorm/cli.js'), 'migration:run', '-d', 'dist/src/config/data-source.js'],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, DB_NAME: TARGET_DB, DATABASE_URL: url(TARGET_DB) },
    },
  );
  console.log('✓ migrations applied');

  // System RBAC catalogue only — the fixtures need the seeded `owner` role and
  // the permission rows their custom roles are built from.
  const src = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: SOURCE_DB });
  const dst = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: TARGET_DB });
  await src.connect();
  await dst.connect();

  const copy = async (table, selectSql) => {
    const rows = (await src.query(selectSql)).rows;
    for (const row of rows) {
      const cols = Object.keys(row);
      await dst.query(
        `INSERT INTO ${table}(${cols.map((c) => `"${c}"`).join(',')}) ` +
          `VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
        cols.map((c) => row[c]),
      );
    }
    return rows.length;
  };

  const p = await copy('permissions', 'SELECT * FROM permissions');
  const r = await copy('roles', 'SELECT * FROM roles WHERE "tenantId" IS NULL');
  const rp = await copy(
    'role_permissions',
    'SELECT rp.* FROM role_permissions rp JOIN roles ro ON ro.id = rp."roleId" WHERE ro."tenantId" IS NULL',
  );
  console.log(`✓ RBAC catalogue copied (permissions=${p} roles=${r} role_permissions=${rp})`);

  const idx = await dst.query(
    `SELECT indexname FROM pg_indexes WHERE indexname LIKE 'UQ_integration%' ORDER BY 1`,
  );
  console.log(`✓ integration unique indexes present: ${idx.rows.length}`);
  for (const row of idx.rows) console.log(`    ${row.indexname}`);
  if (idx.rows.length < 5) {
    throw new Error('Expected the migration-created integration unique indexes to be present');
  }

  await src.end();
  await dst.end();
}

main().catch((e) => {
  console.error('✗ e2e database setup failed:', e.message);
  process.exit(1);
});

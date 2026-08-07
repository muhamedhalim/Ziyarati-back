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
  //
  // Slug-driven, not id-driven: an idempotent data migration (e.g.
  // PlatformSupportRoleAndPermissions) can now seed some of this catalogue
  // directly into `ziyarati_e2e` during the `migration:run` step above,
  // BEFORE this copy runs — with its own freshly-generated ids that don't
  // match SOURCE_DB's ids for the same slug. A blind id-preserving copy (the
  // original approach) then either creates a physical duplicate role row
  // (`roles` has no DB-level unique constraint on slug — see
  // rbac.constants.ts's own comment on that) or, worse, inserts a
  // `role_permissions` row whose `permissionId` points at SOURCE_DB's id for
  // that slug, which doesn't exist in the target — an FK violation. Matching
  // on slug (roles/permissions) or (role slug, permission slug)
  // (role_permissions) instead is correct regardless of which ids either
  // side happens to hold.
  const src = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: SOURCE_DB });
  const dst = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: TARGET_DB });
  await src.connect();
  await dst.connect();

  const copyPermissions = async () => {
    const rows = (await src.query('SELECT * FROM permissions')).rows;
    let inserted = 0;
    for (const row of rows) {
      const cols = Object.keys(row);
      const result = await dst.query(
        `INSERT INTO permissions(${cols.map((c) => `"${c}"`).join(',')}) ` +
          `VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT ("slug") DO NOTHING`,
        cols.map((c) => row[c]),
      );
      inserted += result.rowCount;
    }
    return inserted;
  };

  const copyRoles = async () => {
    const rows = (await src.query('SELECT * FROM roles WHERE "tenantId" IS NULL')).rows;
    let inserted = 0;
    for (const row of rows) {
      const exists = await dst.query(
        'SELECT 1 FROM roles WHERE slug = $1 AND "tenantId" IS NULL',
        [row.slug],
      );
      if (exists.rowCount > 0) continue;
      const cols = Object.keys(row);
      await dst.query(
        `INSERT INTO roles(${cols.map((c) => `"${c}"`).join(',')}) ` +
          `VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        cols.map((c) => row[c]),
      );
      inserted++;
    }
    return inserted;
  };

  const copyRolePermissions = async () => {
    const rows = (
      await src.query(
        'SELECT ro.slug AS role_slug, p.slug AS perm_slug FROM role_permissions rp ' +
          'JOIN roles ro ON ro.id = rp."roleId" JOIN permissions p ON p.id = rp."permissionId" ' +
          'WHERE ro."tenantId" IS NULL',
      )
    ).rows;
    let inserted = 0;
    for (const row of rows) {
      const result = await dst.query(
        `INSERT INTO role_permissions("roleId", "permissionId")
         SELECT ro.id, p.id FROM roles ro, permissions p
         WHERE ro.slug = $1 AND ro."tenantId" IS NULL AND p.slug = $2
         ON CONFLICT DO NOTHING`,
        [row.role_slug, row.perm_slug],
      );
      inserted += result.rowCount;
    }
    return inserted;
  };

  const p = await copyPermissions();
  const r = await copyRoles();
  const rp = await copyRolePermissions();
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

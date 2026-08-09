import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-database-T060-schema-inventory',
    layer: 'database',
    metric: 'index_count',
    value: 105,
    unit: 'count',
    percentile: null,
    sampleSize: 131,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-database-01',
    tool: { name: 'extract-schema.js + entity-file scan', version: 'n/a', invocation: 'node scripts/extract-schema.js' },
    subject: { entityFiles: 131, filesWithIndex: 70, filesWithoutIndex: 61, totalIndexDecorators: 105, confirmedMatchesA1: true, tierNote: 'schema/entity-level fact, tier-independent — T1 recorded as the currently-active tier' },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-database-T061-pg-stat-statements-assessment',
    layer: 'database',
    metric: 'extension_availability',
    value: 1,
    unit: 'count',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-database-01',
    tool: { name: 'pg_available_extensions + SHOW shared_preload_libraries', version: 'n/a', invocation: 'psql -c "SELECT * FROM pg_available_extensions WHERE name = \'pg_stat_statements\'; SHOW shared_preload_libraries;"' },
    subject: { available: true, version: '1.12', preloaded: false, requiresRestart: true, verdict: 'measured-immaterial for this audit, recommended for production observability separately' },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-database-T063-baseline',
    layer: 'database',
    metric: 'database_size_bytes',
    value: 125829120,
    unit: 'bytes',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-database-01',
    tool: { name: 'psql (13-item baseline)', version: 'n/a', invocation: 'MP-database-01 full step list' },
    subject: {
      databaseSizePretty: '120 MB',
      topTables: { messages: '33MB (160000 rows)', appointments: '30MB (60000 rows)', payments: '16MB (40000 rows)', invoices: '11MB (40000 rows)', customers: '6.4MB (15000 rows)' },
      activeConnections: 1,
      idleConnections: 5,
      poolMax: 15,
      poolUsagePercent: 40,
      lockWaits: 0,
      longRunningQueries: 0,
      statsViewResetArtifact: 'pg_stat_user_tables counters reset on the mid-session Postgres restart (47min uptime); pg_class.reltuples (actual planner input) confirmed accurate against real COUNT(*) — not a planner-accuracy defect',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
];

let failed = 0;
for (const r of records) {
  try {
    const w = writeEvidenceRecord(r, { knownProcedureIds: KNOWN });
    console.log(`OK ${w.id}`);
  } catch (e) {
    console.error(`FAIL ${r.id}: ${(e as Error).message}`);
    failed++;
  }
}
if (failed) process.exit(1);

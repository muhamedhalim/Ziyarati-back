import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-database-T064-query-plans',
    layer: 'database',
    metric: 'query_execution_cost',
    value: 6.945,
    unit: 'ms',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-database-02',
    tool: { name: 'EXPLAIN (ANALYZE, BUFFERS)', version: 'postgres 18.4', invocation: 'psql -c "EXPLAIN (ANALYZE, BUFFERS) SELECT ... FROM appointments a LEFT JOIN branches/customers/staff_profiles ... LIMIT 20"' },
    subject: {
      queryShape: 'appointments list with 3 LEFT JOINs, tenant-scoped, LIMIT 20',
      appointmentsAccess: 'Bitmap Index Scan on IDX_d01da6e11544bb3362ddd538dd (efficient)',
      customersAccess: 'Seq Scan, full 15000 rows, to build hash-join side',
      flaggedForT2: 'customers seq-scan strategy — watch for a plan flip once customers grows 10x at T2',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-database-T065-T067-maintenance',
    layer: 'database',
    metric: 'dead_tuple_count',
    value: 0,
    unit: 'count',
    percentile: null,
    sampleSize: 5,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-database-04',
    tool: { name: 'pg_stat_user_tables', version: 'postgres 18.4', invocation: 'SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables' },
    subject: {
      tablesChecked: ['appointments', 'messages', 'payments', 'customers', 'invoices'],
      deadTuplesEverywhere: 0,
      autovacuumOn: true,
      pgstattupleAvailable: true,
      pgstattupleInstalled: false,
      journeyQueryCountsCovered: '4/10 (reused from T051), remaining 6 deferred to A10',
    },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
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

import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-database-T069-T070-baseline-and-flip',
    layer: 'database',
    metric: 'plan_flip_execution_cost',
    value: 9.767,
    unit: 'ms',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-database-02',
    tool: { name: 'EXPLAIN (ANALYZE, BUFFERS)', version: 'postgres 18.4', invocation: 'identical query to T064, re-run against T2' },
    subject: {
      t1ExecutionMs: 6.945,
      t2ExecutionMs: 9.767,
      deltaPercent: 41,
      t1Strategy: 'Hash Left Join, Seq Scan on customers (15000 rows)',
      t2Strategy: 'Nested Loop Left Join, Index Scan on customers PK, Parallel Bitmap Heap Scan on appointments, Memoize node',
      verdict: 'confirmed real plan flip, planner working correctly, sub-linear latency scaling',
      dbSizeT1Mb: 120, dbSizeT2Mb: 1484, dbSizeRatio: 12.4,
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-database-T071-T072-query-counts-ranking',
    layer: 'database',
    metric: 'query_count_stability',
    value: 0,
    unit: 'count',
    percentile: null,
    sampleSize: 4,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-database-03',
    tool: { name: 'live query-count-per-request log-diffing, repeated at T2', version: 'n/a', invocation: 'same method as T051' },
    subject: {
      t1Counts: { 'analytics/dashboard': 7, appointments: 9, 'crm/customers': 9, staff: 12 },
      t2Counts: { 'analytics/dashboard': 8, appointments: 9, 'crm/customers': 9, staff: 12 },
      deltaAssessment: 'flat across 12-17x data volume growth, as expected',
      highestIoQuery: 'appointments-list-with-joins at T2: 87 real disk reads (buffers read=87) vs 0 at T1 (fully cache-resident)',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-database-T073-index-audit',
    layer: 'database',
    metric: 'redundant_index_count',
    value: 1,
    unit: 'count',
    percentile: null,
    sampleSize: 26,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-database-01',
    tool: { name: 'pg_indexes column-prefix comparison', version: 'postgres 18.4', invocation: 'SELECT tablename, indexdef FROM pg_indexes WHERE tablename IN (...)' },
    subject: {
      redundantIndex: 'payments.IDX_63a284e4446aa8efee9dff1ea8 (tenantId,status) is a strict column prefix of idx_payments_settlement_claim (tenantId,status,settlement_status,paid_at)',
      sizeBytes: 6016000,
      zeroIndexesCreated: true,
      idxScanCaveat: '305/355 indexes show idx_scan=0 on this freshly-seeded database — explicitly NOT reported as unused, this audits synthetic traffic covers a small fraction of the 654 real routes',
    },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-database-T074-pool-saturation',
    layer: 'database',
    metric: 'pool_contention_latency',
    value: 628,
    unit: 'ms',
    percentile: 50,
    sampleSize: 25,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-database-01',
    tool: { name: 'Promise.all concurrent fetch burst', version: 'n/a', invocation: 'N concurrent GET /api/v1/appointments?limit=50 requests' },
    subject: {
      poolMax: 15,
      n10MedianMs: 338,
      n25MedianMs: 628,
      deltaPercent: 86,
      concurrencyOverPoolPercent: 67,
      scopeReduction: 'API process root only, worker root pool saturation not tested this pass',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: 'burst-25-concurrent' },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-database-T074-pgvector-gap',
    layer: 'database',
    metric: 'extension_availability',
    value: 0,
    unit: 'count',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-database-01',
    tool: { name: 'pg_available_extensions', version: 'postgres 18.4', invocation: "SELECT * FROM pg_available_extensions WHERE name='vector'" },
    subject: { availableRows: 0, reConfirmedFromT010: true, verdict: 'LOCAL capability gap (image lacks the shared library), not an access-based EER' },
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

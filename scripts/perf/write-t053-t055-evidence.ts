import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-backend-T053-blocking-work-check',
    layer: 'backend',
    metric: 'blocking_sync_call_count',
    value: 0,
    unit: 'count',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: null,
    procedureId: 'MP-backend-01',
    tool: { name: 'grep across src/', version: 'n/a', invocation: 'grep -rl "readFileSync|writeFileSync|execSync|readdirSync" src/' },
    subject: { checkedFor: ['readFileSync', 'writeFileSync', 'execSync', 'readdirSync'], matchesOutsideTests: 0 },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T054-T055-runtime-metrics',
    layer: 'backend',
    metric: 'eventloop_lag_seconds',
    value: 0.00537,
    unit: 'ms',
    percentile: null,
    sampleSize: 86,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-04',
    tool: { name: 'collectDefaultMetrics via GET /api/v1/metrics', version: 'prom-client (repo-pinned)', invocation: 'curl http://127.0.0.1:3001/api/v1/metrics' },
    subject: {
      idle: { eventloopLagMs: 8.46, heapUsedMb: 91.5, heapTotalMb: 98.3, residentMb: 280.6 },
      lightLoad: { reqPerSec: 3.4, durationS: 25, requestCount: 86, eventloopLagMs: 5.37, heapUsedMb: 108.3, heapTotalMb: 166.5, residentMb: 281.3, cpuPerRequestMs: 44 },
      scopeReduction: 'idle vs light-to-normal only, API process only — true peak/sustained/stress and worker profiling deferred to A11',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: 'light-to-normal' },
    instrumentationActive: ['collectDefaultMetrics'],
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

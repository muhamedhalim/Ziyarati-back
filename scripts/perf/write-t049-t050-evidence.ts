import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-backend-T049-compression-ratios',
    layer: 'backend',
    metric: 'compression_ratio',
    value: 94,
    unit: 'percent',
    percentile: null,
    sampleSize: 3,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-01',
    tool: { name: 'zlib.gzipSync/brotliCompressSync over real captured response bodies', version: 'node builtin', invocation: 'GET with Accept-Encoding: gzip, br, then recompress the raw (uncompressed) response locally' },
    subject: {
      endpoint: '/api/v1/appointments',
      rawBytes: 148132,
      gzipBytes: 8425,
      brotliBytes: 6551,
      serverContentEncoding: 'NONE — confirmed no compression applied despite client Accept-Encoding',
      limitation: 'LOCAL is loopback; byte savings measured directly, latency savings inferred not measured',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T050-observability-gap',
    layer: 'backend',
    metric: 'guard_rejection_blind_spot',
    value: 1,
    unit: 'count',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: null,
    procedureId: 'MP-backend-01',
    tool: { name: 'architectural analysis, reusing T025s canonical verdict', version: 'n/a', invocation: 'n/a — code/config review' },
    subject: {
      finding: 'api_logs cannot see guard-rejected requests (T025 canonical verdict); a correctly-positioned Prometheus histogram could',
      existingTooling: ['api_logs ledger', 'MetricsService/collectDefaultMetrics (process-level only, no HTTP histogram)'],
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

import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-backend-T154-compression-after',
    layer: 'backend',
    metric: 'compression_ratio_after',
    value: 95.02,
    unit: 'percent',
    percentile: null,
    sampleSize: 3,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-01',
    tool: {
      name: 'compression@1.8.1 (live server, actual Content-Encoding) + Node http/zlib capture',
      version: 'node builtin + compression 1.8.1',
      invocation: 'GET with Accept-Encoding: gzip, br against the compression-enabled build; wire bytes measured directly, not recompressed offline',
    },
    subject: {
      fix: 'app.use(compression()) registered in src/main.ts (PERF-BE-001, T148)',
      perEndpoint: [
        { endpoint: '/api/v1/appointments?limit=100', rawBytes: 148132, gzipBytes: 8425, gzipPct: 94.31, brotliBytes: 7372, brotliPct: 95.02, contentEncodingServed: 'br' },
        { endpoint: '/api/v1/crm/customers?limit=100', rawBytes: 52579, gzipBytes: 3886, gzipPct: 92.61, brotliBytes: 3219, brotliPct: 93.88, contentEncodingServed: 'br' },
        { endpoint: '/api/v1/invoices?limit=100', rawBytes: 20764, gzipBytes: 2949, gzipPct: 85.80, brotliBytes: 2718, brotliPct: 86.91, contentEncodingServed: 'br' },
      ],
      latencyMsSequential40PerEndpoint: {
        appointments: { identity: { p50: 87.68, p95: 105.31, p99: 201.12 }, compressed: { p50: 86.80, p95: 109.44, p99: 113.73 } },
        customers: { identity: { p50: 44.01, p95: 53.68, p99: 53.83 }, compressed: { p50: 45.38, p95: 55.08, p99: 55.56 } },
        invoices: { identity: { p50: 41.57, p95: 55.55, p99: 56.73 }, compressed: { p50: 42.09, p95: 55.33, p99: 55.34 } },
      },
      concurrentComparisonAutocannon: {
        note: 'rate-capped at 4 req/s (4 connections, 20s, 80 requests) to stay under the real 300/60s ThrottlerGuard ceiling, which an uncapped 10c/10s burst confirmed is untouched (300 2xx then 4861 real 429s)',
        identity: { p50Ms: 64, p97_5Ms: 143, p99Ms: 158, throughputReqSec: 4.0, bandwidthKBs: 594, errors: 0, timeouts: 0, requests: 80 },
        compressed: { p50Ms: 69, p97_5Ms: 140, p99Ms: 148, throughputReqSec: 4.0, bandwidthKBs: 31.4, errors: 0, timeouts: 0, requests: 80 },
      },
      cpuCostMsPerRequestAppointments: { identityBaseline: 56.25, compressed: 71.88, deltaAttributableToCompression: 15.6, method: 'Windows Get-Process.TotalProcessorTime delta, 30-request matched bursts, same process' },
      errorRate: { identitySequential: '0/120', compressedSequential: '0/120', autocannonIdentity: '0/80', autocannonCompressed: '0/80' },
      contentIntegrity: 'brotli-decompressed body byte-for-byte identical (Buffer.compare === 0) to the raw uncompressed body on all 3 endpoints plus one 400 error body',
      regressionSuites: { unit: '265/265 suites, 3458/3458 tests', securitySensitiveE2e: '10/10 suites, 81/81 tests (auth, tenant-isolation, concurrency, idempotency, webhook, rate-limit)' },
      targetDerivedAtT145: '85% floor (measured-baseline, lower bound of T049 gzip ratios)',
      validationResult: 'met',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-b-perf-be-001',
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

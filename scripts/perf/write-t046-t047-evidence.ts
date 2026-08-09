/**
 * Materializes the EvidenceRecords for T046/T047's findings
 * (reports/backend-percentiles.md), using the real evidence-record.ts writer
 * (V1-V8), not a reimplementation.
 */
import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';
import percentiles from './endpoint-percentiles-results.json';
import traffic from './traffic-burst-results.json';

const ENV_SPEC: EnvironmentSpec = {
  nodeVersion: 'v24.18.1',
  postgresVersion: '18.4',
  redisVersion: '7.4.10',
  nodeEnvActual: 'development',
};

const KNOWN_PROCEDURE_IDS = [
  'MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04',
  'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05',
];

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-backend-T046-ledger-percentiles',
    layer: 'backend',
    metric: 'ledger_p95',
    value: (percentiles.rows.find((r: { endpoint: string }) => r.endpoint === '/api/v1/appointments')! as { p95_ms: number }).p95_ms,
    unit: 'ms',
    percentile: 95,
    sampleSize: percentiles.totalRowsInLedger,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-01',
    tool: { name: 'endpoint-percentiles.ts (percentile_cont over api_logs)', version: 'n/a', invocation: 'npx ts-node -r tsconfig-paths/register scripts/perf/endpoint-percentiles.ts' },
    subject: { endpointClass: 'standard-crud', endpoint: '/api/v1/appointments', auditQueryExecutionMs: percentiles.auditQueryExecutionMs, distinctEndpointMethodCombos: percentiles.rows.length },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T046-auth-login-bcrypt',
    layer: 'backend',
    metric: 'auth_login_ledger_p95',
    value: (percentiles.rows.find((r: { endpoint: string }) => r.endpoint === '/api/v1/auth/login')! as { p95_ms: number }).p95_ms,
    unit: 'ms',
    percentile: 95,
    sampleSize: (percentiles.rows.find((r: { endpoint: string }) => r.endpoint === '/api/v1/auth/login')! as { n: number }).n,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-01',
    tool: { name: 'endpoint-percentiles.ts (percentile_cont over api_logs)', version: 'n/a', invocation: 'npx ts-node -r tsconfig-paths/register scripts/perf/endpoint-percentiles.ts' },
    subject: { endpointClass: 'authentication', endpoint: '/api/v1/auth/login', rootCause: 'bcrypt BCRYPT_ROUNDS=12 (src/modules/auth/auth.service.ts:41) — expected, not misconfigured' },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T046-handovers-error-rate',
    layer: 'backend',
    metric: 'error_rate',
    value: 1.0,
    unit: 'ratio',
    percentile: null,
    sampleSize: (percentiles.rows.find((r: { endpoint: string }) => r.endpoint === '/api/v1/ai/handovers')! as { n: number }).n,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-01',
    tool: { name: 'endpoint-percentiles.ts + live reproduction request', version: 'n/a', invocation: 'GET /api/v1/ai/handovers with a valid owner session cookie' },
    subject: {
      endpointClass: 'AI operations',
      endpoint: '/api/v1/ai/handovers',
      errorType: 'QueryFailedError',
      errorMessage: 'column HandoverRequest.transferredFromId does not exist',
      rootCauseFile: 'src/entities/AI Agent/HandoverRequest.ts:36-37 (missing @JoinColumn on transferred_from relation)',
      failingCallSite: 'src/modules/ai/handover-request.service.ts:200 (HandoverRequestService.findAll)',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T047-client-vs-ledger-divergence',
    layer: 'backend',
    metric: 'client_ledger_divergence',
    value: 1024,
    unit: 'percent',
    percentile: null,
    sampleSize: 136,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-02',
    tool: { name: 'traffic-burst.js (paced sequential fetch, autocannon substitute — throttle-budget-constrained)', version: 'n/a', invocation: 'node scripts/perf/traffic-burst.js' },
    subject: {
      endpointClass: 'fast-reads',
      endpoint: '/api/v1/branches',
      clientP50Ms: median((traffic.results['fast reads'] as Array<{ path: string; ms: number }>).filter((r) => r.path === '/api/v1/branches').map((r) => r.ms)),
      ledgerP50Ms: (percentiles.rows.find((r: { endpoint: string }) => r.endpoint === '/api/v1/branches')! as { p50_ms: number }).p50_ms,
      reconciliationRule: 'T028: client-observed is reference on material disagreement (>30%); annotate, never blend',
      note: 'Direction opposite T022 (server>client there, client>server here) — attributed to differing concurrency/pacing profile between measurement runs, not resolved; T048 must decompose via in-lifecycle instrumentation rather than further black-box inference',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
];

let failed = 0;
for (const input of records) {
  try {
    const written = writeEvidenceRecord(input, { knownProcedureIds: KNOWN_PROCEDURE_IDS });
    console.log(`OK ${written.id}`);
  } catch (e) {
    console.error(`FAIL ${input.id}: ${(e as Error).message}`);
    failed++;
  }
}
if (failed > 0) {
  console.error(`${failed} record(s) failed.`);
  process.exit(1);
}
console.log(`\nWrote ${records.length} EvidenceRecords.`);

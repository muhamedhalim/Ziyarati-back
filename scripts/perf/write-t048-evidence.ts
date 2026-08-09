import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = {
  nodeVersion: 'v24.18.1',
  postgresVersion: '18.4',
  redisVersion: '7.4.10',
  nodeEnvActual: 'development',
};

const record: EvidenceRecordInput = {
  id: 'EV-backend-T048-fixed-cost-decomposition',
  layer: 'backend',
  metric: 'guard_chain_estimated_cost',
  value: 27,
  unit: 'ms',
  percentile: 50,
  sampleSize: 8,
  environmentClass: 'LOCAL',
  environmentSpec: ENV_SPEC,
  dataTier: 'T1',
  procedureId: 'MP-backend-03',
  tool: { name: 'baseline-subtraction (liveness no-op vs authenticated routes)', version: 'n/a', invocation: 'client fetch of GET /api/v1/system/health/liveness (n=20) vs T047 authenticated-route client/ledger pairs' },
  subject: {
    method: 'compare client-observed vs ledger-recorded time for a @Public() no-op route (isolates pre-interceptor cost) then compare that pre-interceptor cost between public and authenticated routes (isolates JwtAuthGuard + RBAC/tenant-context resolution specifically)',
    livenessClientP50Ms: 23.6,
    livenessLedgerP50Ms: 0,
    authenticatedRouteExamples: ['/api/v1/branches', '/api/v1/permissions', '/api/v1/analytics/dashboard'],
    estimatedFloorMs: 24,
    estimatedAuthGuardRbacMs: 27,
    apiLogWriteMsReusedFromT023: 4.28,
    scopeReduction: 'aggregate pre/post-interceptor split only, not per-guard (Throttler/Csrf/Maintenance/Subscription/Feature individually) — disclosed, not a controlled single-variable experiment',
  },
  context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
  instrumentationActive: [],
  operator: 'performance-audit-006-stage-a',
};

const written = writeEvidenceRecord(record, {
  knownProcedureIds: ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05'],
});
console.log(`OK ${written.id}`);

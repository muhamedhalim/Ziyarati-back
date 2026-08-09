import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'test (load-test window only, restored to development immediately after)' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04', 'MP-cache-01', 'MP-cache-02', 'MP-cache-03', 'MP-external-01', 'MP-external-02', 'MP-infra-01', 'MP-e2e-01', 'MP-load-01'];

const record: EvidenceRecordInput = {
  id: 'EV-load-T107-T115-profiles',
  layer: 'e2e',
  metric: 'failure_rate',
  value: 10.3,
  unit: 'percent',
  percentile: null,
  sampleSize: 2327,
  environmentClass: 'LOCAL',
  environmentSpec: ENV_SPEC,
  dataTier: 'T2',
  procedureId: 'MP-load-01',
  tool: { name: 'Artillery 2.0.33', version: '2.0.33', invocation: 'npx artillery run scripts/perf/load/{journeys.yml,stress.yml}' },
  subject: {
    scenario: 'J-02 composite (dashboard+appointments+crm/customers+staff)',
    baselineNormalPeakFailures: 0,
    baselineNormalPeakP95Ms: 113.3,
    stressFailures: 240,
    stressP95Ms: 6838,
    stressP99Ms: 7865.6,
    likelyFirstSaturatingComponent: 'DB connection pool (DB_POOL_MAX=15), consistent with but not conclusively re-confirmed against T074 PERF-DB-001',
    scopeReduction: '1 of 10 journeys, 4 of 6 profiles combined, T2 only, no dedicated sustained run',
    productionTransferable: false,
  },
  context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: '2x-peak-burst' },
  instrumentationActive: [],
  operator: 'performance-audit-006-stage-a',
};

const w = writeEvidenceRecord(record, { knownProcedureIds: KNOWN });
console.log(`OK ${w.id}`);

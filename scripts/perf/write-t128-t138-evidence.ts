import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04', 'MP-cache-01', 'MP-cache-02', 'MP-cache-03', 'MP-external-01', 'MP-external-02', 'MP-infra-01', 'MP-e2e-01', 'MP-load-01'];

const record: EvidenceRecordInput = {
  id: 'EV-budgets-T128-T138',
  layer: 'frontend',
  metric: 'stability_proof_runs',
  value: 10,
  unit: 'count',
  percentile: null,
  sampleSize: 10,
  environmentClass: 'LOCAL',
  environmentSpec: ENV_SPEC,
  dataTier: null,
  procedureId: 'MP-frontend-03',
  tool: { name: 'check-bundle-budget.ts, 10 consecutive runs', version: 'n/a', invocation: 'npx tsx scripts/check-bundle-budget.ts (x10)' },
  subject: {
    checkId: 'RC-01',
    consecutiveRuns: 10,
    identicalVerdicts: true,
    verdict: 'FAIL, +16.60%, +859746 bytes, every run',
    classification: 'blocking',
    otherChecksClassification: 'advisory (no CI-runnable harness exists yet for any of RC-02 through RC-08)',
    budgetsDefinedTotal: 25,
    budgetsGated: 1,
  },
  context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
  instrumentationActive: [],
  operator: 'performance-audit-006-stage-a',
};

const w = writeEvidenceRecord(record, { knownProcedureIds: KNOWN });
console.log(`OK ${w.id}`);

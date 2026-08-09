import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04', 'MP-cache-01', 'MP-cache-02', 'MP-cache-03', 'MP-external-01', 'MP-external-02', 'MP-infra-01', 'MP-e2e-01'];

const record: EvidenceRecordInput = {
  id: 'EV-e2e-T101-T106-journey-decomposition',
  layer: 'e2e',
  metric: 'unattributed_share',
  value: 72,
  unit: 'percent',
  percentile: null,
  sampleSize: 2,
  environmentClass: 'LOCAL',
  environmentSpec: ENV_SPEC,
  dataTier: 'T2',
  procedureId: 'MP-e2e-01',
  tool: { name: 'composed decomposition from already-measured pieces (T033/T037/T046/T047/T048/T051/T078/T079)', version: 'n/a', invocation: 'n/a — synthesis, not a fresh measurement run' },
  subject: {
    journeysFullyDecomposed: 2,
    journeysLightlyTreated: 8,
    j01UnattributedMsRange: [3943, 4009],
    j01UnattributedPercent: 72,
    j01Explanation: 'consistent with PERF-FE-001 frontend rendering pipeline cost, not asserted as mystery time',
    scopeReduction: 'a dedicated fresh correlated browser+backend trace per journey was not built this phase',
  },
  context: { locale: 'en', role: 'owner', viewport: null, theme: null, loadProfile: null },
  instrumentationActive: [],
  operator: 'performance-audit-006-stage-a',
};

const w = writeEvidenceRecord(record, { knownProcedureIds: KNOWN });
console.log(`OK ${w.id}`);

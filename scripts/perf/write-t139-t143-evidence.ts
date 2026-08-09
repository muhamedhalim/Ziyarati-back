import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04', 'MP-cache-01', 'MP-cache-02', 'MP-cache-03', 'MP-external-01', 'MP-external-02', 'MP-infra-01', 'MP-e2e-01', 'MP-load-01'];

const record: EvidenceRecordInput = {
  id: 'EV-roadmap-T139-T141',
  layer: 'e2e',
  metric: 'optimization_tasks_drafted',
  value: 16,
  unit: 'count',
  percentile: null,
  sampleSize: 16,
  environmentClass: 'LOCAL',
  environmentSpec: ENV_SPEC,
  dataTier: 'T2',
  procedureId: 'MP-e2e-01',
  tool: { name: 'manual roadmap drafting from consolidated findings', version: 'n/a', invocation: 'n/a' },
  subject: {
    tasksDrafted: 16,
    tasksRejectedForMissingElement: 0,
    tasksNeedingSecurityReview: 3,
    tasksLocalBounded: 16,
    tasksBlocked: 3,
    tasksImplemented: 0,
    triplicatedTo: ['specs/006-platform-performance-audit/reports/', 'Ziyarati-back/docs/', 'Ziyarati-font/docs/'],
  },
  context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
  instrumentationActive: [],
  operator: 'performance-audit-006-stage-a',
};

const w = writeEvidenceRecord(record, { knownProcedureIds: KNOWN });
console.log(`OK ${w.id}`);

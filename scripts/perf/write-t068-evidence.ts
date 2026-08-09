import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04'];

const record: EvidenceRecordInput = {
  id: 'EV-database-T068-t1-t2-switch',
  layer: 'database',
  metric: 'seed_row_count_match',
  value: 900000,
  unit: 'count',
  percentile: null,
  sampleSize: 9,
  environmentClass: 'LOCAL',
  environmentSpec: ENV_SPEC,
  dataTier: 'T2',
  procedureId: 'MP-database-01',
  tool: { name: 'reports/data-tiers.md §T020 switch procedure, executed verbatim', version: 'n/a', invocation: 'CREATE DATABASE + migration:run + npm run seed + npm run seed:perf -- --tier=T2' },
  subject: {
    seedDurationSeconds: 588.15,
    migrationsApplied: 75,
    achievedCounts: { tenants: 500, customers: 200000, appointments: 900000, invoices: 600000, payments: 600000, conversations: 300000, messages: 2400000, branches: 1750, users: 3500 },
    targets: { tenants: 500, customers: 200000, appointments: 900000, invoices: 600000, payments: 600000, conversations: 300000, messages: 2500000, branches: 1200, users: 3000 },
    readinessConfirmed: true,
    boundaryIntegrity: 'no measurement in flight during the switch, confirmed',
  },
  context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
  instrumentationActive: [],
  operator: 'performance-audit-006-stage-a',
};

const w = writeEvidenceRecord(record, { knownProcedureIds: KNOWN });
console.log(`OK ${w.id}`);

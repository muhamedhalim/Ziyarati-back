import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-backend-T051-query-counts',
    layer: 'backend',
    metric: 'queries_per_request',
    value: 12,
    unit: 'count',
    percentile: null,
    sampleSize: 4,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-01',
    tool: { name: 'live query-count-per-request via api log-diffing', version: 'n/a', invocation: 'diff TYPEORM_LOGGING output line-count before/after a single isolated request' },
    subject: {
      endpoints: { 'analytics/dashboard': 7, 'appointments?limit=20': 9, 'crm/customers?limit=20': 9, staff: 12 },
      noNPlus1Confirmed: true,
      overFetchingObservation: 'GET /api/v1/staff eager-loads a PasswordReset relation with no apparent list-view use',
      falsePositiveRuledOut: 'two SystemSetting queries per request are different keys (maintenance_mode, billing.mode), not a duplicate',
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: ['TYPEORM_LOGGING'],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T052-sequential-awaits',
    layer: 'backend',
    metric: 'sequential_independent_await_chains',
    value: 6,
    unit: 'count',
    percentile: null,
    sampleSize: 10,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: null,
    procedureId: 'MP-backend-01',
    tool: { name: 'targeted code read of the 10 named heavy modules', version: 'n/a', invocation: 'n/a — static code review' },
    subject: {
      instances: [
        'scheduling/availability.service.ts:284,286 (evaluate() — critical booking-conflict hot path)',
        'scheduling/availability.service.ts:191,200',
        'platform-finance/marketplace-finance.service.ts:391,412,418,425 (4-way)',
        'platform-finance/marketplace-finance.service.ts:258-281 (4-way +1 dependent)',
        'platform-support/support-integration.service.ts:118-119,126-127 (2 call sites)',
        'conversations/conversation.service.ts:43-46 (up to 4-way)',
        'campaigns/campaign-execution.service.ts:317,323',
      ],
      modulesCheckedClean: ['analytics/** (consistently uses Promise.all already)'],
      note: 'no millisecond figures attached — structural finding with file:line evidence only, quantification is a stated gap',
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

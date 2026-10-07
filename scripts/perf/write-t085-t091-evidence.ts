import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04', 'MP-cache-01', 'MP-cache-02', 'MP-cache-03', 'MP-external-01', 'MP-external-02'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-external-T085-provider-seams',
    layer: 'external',
    metric: 'real_credential_count',
    value: 3,
    unit: 'count',
    percentile: null,
    sampleSize: 5,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: null,
    procedureId: 'MP-external-01',
    tool: { name: '.env inspection + provider factory code review', version: 'n/a', invocation: 'grep for credential env vars, cross-referenced with provider selection logic' },
    subject: {
      realCredentials: ['OPENAI_API_KEY', 'RESEND_API_KEY (active provider)', 'R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY (real bucket)'],
      emptyCredentials: ['TAP_TEST_SECRET_KEY (routes to NoopGatewayProvider by construction)', 'META_APP_ID/META_APP_SECRET'],
      safetyDecision: 'no live call to OpenAI, Resend, or R2 this phase; extended the same caution to Meta despite empty credentials',
    },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-external-T086-T090-analysis',
    layer: 'external',
    metric: 'services_with_live_measurement',
    value: 0,
    unit: 'count',
    percentile: null,
    sampleSize: 5,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: null,
    procedureId: 'MP-external-01',
    tool: { name: 'static code review of timeout/retry configuration', version: 'n/a', invocation: 'n/a' },
    subject: {
      timeoutsConfirmedConfigured: { openai: 30000, meta: 10000, webhookDelivery: 10000 },
      timeoutsEmpiricallyProven: 0,
      withTimeoutUtilCallSites: 1,
      noopProviderBlastRadius: 'zero (the payment gateway always no-ops in this env by construction)',
      aiCostDriversMeasured: 0,
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

import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04', 'MP-cache-01', 'MP-cache-02', 'MP-cache-03', 'MP-external-01', 'MP-external-02', 'MP-infra-01', 'MP-e2e-01', 'MP-load-01'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-consolidation-T116-T118',
    layer: 'e2e',
    metric: 'consolidated_finding_count',
    value: 17,
    unit: 'count',
    percentile: null,
    sampleSize: 18,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-e2e-01',
    tool: { name: 'manual consolidation + contract validation review', version: 'n/a', invocation: 'n/a' },
    subject: {
      rawFindingCount: 18,
      reclassifiedToFollowup: 1,
      consolidatedCount: 17,
      duplicatesFound: 0,
      f1ThroughF8Status: 'F1-F5 confirmed passing (F5 minor tally inconsistency self-caught and disclosed), F6-F8 not applicable (Stage A only)',
    },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-consolidation-T122-reproducibility',
    layer: 'e2e',
    metric: 'reproduction_deviation',
    value: 25,
    unit: 'percent',
    percentile: 50,
    sampleSize: 10,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-backend-02',
    tool: { name: 're-run of the T047/T048 client-timing method', version: 'n/a', invocation: 'n/a' },
    subject: {
      findingReVerified: 'PERF-BE-003',
      staleSessionCaughtAndCorrected: true,
      livenessDeviationPercent: 9,
      branchesDeviationPercent: 25,
      verdict: 'reproduces, borderline on one sub-metric, not reclassified unstable',
      otherP0P1FindingsNotReVerified: ['PERF-FE-001', 'PERF-FE-003', 'PERF-CACHE-001', 'PERF-E2E-001'],
    },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
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

import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05', 'MP-database-01', 'MP-database-02', 'MP-database-03', 'MP-database-04', 'MP-cache-01', 'MP-cache-02', 'MP-cache-03', 'MP-external-01', 'MP-external-02', 'MP-infra-01'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-infra-T093-T096-startup-and-readiness',
    layer: 'infrastructure',
    metric: 'startup_to_ready_cost',
    value: 4,
    unit: 's',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T2',
    procedureId: 'MP-infra-01',
    tool: { name: 'log-timestamp-based restart timing', version: 'n/a', invocation: 'PowerShell Start-Process with precise timestamps, cross-referenced against Nest bootstrap log lines' },
    subject: {
      apiWarmRestartS: 4,
      workerWarmRestartS: 3,
      apiColdRestartS: '30-40 (earlier this session, post-infrastructure-restart or fresh-seed)',
      readinessProbeLatencyMsRange: [7, 27],
      readinessProbeCapMs: 1500,
      dockerfilesFound: 0,
      queueDepthBlindSpot: 'readiness probe deliberately excludes queue depth per its own documented security rationale',
    },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-infra-T099-application-level',
    layer: 'infrastructure',
    metric: 'keepalive_confirmed',
    value: 1,
    unit: 'count',
    percentile: null,
    sampleSize: 1,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: null,
    procedureId: 'MP-infra-01',
    tool: { name: 'curl -D- header inspection', version: 'n/a', invocation: 'curl -D- -o /dev/null <readiness endpoint>' },
    subject: {
      connectionHeader: 'keep-alive',
      keepAliveTimeoutS: 5,
      nodeOptionsConfigured: false,
      maxOldSpaceSizeConfigured: false,
      dnsApplicable: false,
      tlsApplicable: false,
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

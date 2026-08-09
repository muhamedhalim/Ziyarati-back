import { writeEvidenceRecord, type EvidenceRecordInput, type EnvironmentSpec } from './evidence-record';
import queueResults from './queue-metrics-results.json';

const ENV_SPEC: EnvironmentSpec = { nodeVersion: 'v24.18.1', postgresVersion: '18.4', redisVersion: '7.4.10', nodeEnvActual: 'development' };
const KNOWN = ['MP-frontend-01', 'MP-frontend-02', 'MP-frontend-03', 'MP-frontend-04', 'MP-backend-01', 'MP-backend-02', 'MP-backend-03', 'MP-backend-04', 'MP-backend-05'];

const records: EvidenceRecordInput[] = [
  {
    id: 'EV-backend-T056-cache-eviction-audit',
    layer: 'backend',
    metric: 'unbounded_cache_count',
    value: 3,
    unit: 'count',
    percentile: null,
    sampleSize: 4,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: null,
    procedureId: 'MP-backend-01',
    tool: { name: 'code-based read/write-path eviction audit', version: 'n/a', invocation: 'n/a — static code review of all 4 named in-process caches' },
    subject: {
      caches: [
        'worker-authorization.service.ts:57-59 (3 Maps, 30s TTL, never actively deleted on expiry)',
        'integration-service-account.service.ts:55 (no TTL, self-documented as never evicted)',
        'whatsapp-bot-actor.service.ts:47 (60s TTL, has explicit invalidation delete, no sweep of naturally-expired)',
        'timezone.util.ts:18 (no TTL, but bounded by ~dozens of real timezone strings — safe)',
      ],
      liveHeapSnapshotCaptured: false,
      scopeReduction: 'code-based verdict only, no live entry-count/memory-footprint snapshot this pass',
    },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T057-queue-metrics',
    layer: 'backend',
    metric: 'queue_job_cost',
    value: 209,
    unit: 'ms',
    percentile: null,
    sampleSize: (queueResults.queuesWithState as Array<{ completed: number }>).reduce((a, q) => a + (q.completed || 0), 0),
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-05',
    tool: { name: 'BullMQ getJobCounts + getJobs (read-only)', version: 'bullmq (repo-pinned)', invocation: 'npx ts-node -r tsconfig-paths/register scripts/perf/queue-metrics.ts' },
    subject: {
      totalQueues: queueResults.totalQueues,
      queuesWithAnyState: queueResults.queuesWithState.length,
      allFailedCounts: 0,
      allWaitingActiveCounts: 0,
      note: 'only cron/repeatable maintenance queues have activity this session; request-triggered queues (whatsapp-webhook, campaigns.processRecipient, etc.) untested — no mutating traffic generated this pass',
    },
    context: { locale: null, role: null, viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'performance-audit-006-stage-a',
  },
  {
    id: 'EV-backend-T058-worker-role-split-blocked',
    layer: 'backend',
    metric: 'worker_role_partition_correctness',
    value: 1,
    unit: 'count',
    percentile: null,
    sampleSize: 27,
    environmentClass: 'LOCAL',
    environmentSpec: ENV_SPEC,
    dataTier: 'T1',
    procedureId: 'MP-backend-05',
    tool: { name: 'source-level proof + live probe worker boot', version: 'n/a', invocation: 'WORKER_ROLE=critical node dist/src/worker (temporary, ~12s, stopped cleanly)' },
    subject: {
      partitionVerified: 'queuesForRole(dispatch)=[campaigns.processRecipient] (1), queuesForRole(critical)=26 others, complete non-overlapping partition confirmed from source',
      liveProbeConfirmed: true,
      throughputPoolWaitMeasured: false,
      blockedReason: 'campaigns/campaign_recipients deliberately not seeded in T1 perf-fixture (documented A3 scope decision) — no real dispatch backlog exists to measure against',
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

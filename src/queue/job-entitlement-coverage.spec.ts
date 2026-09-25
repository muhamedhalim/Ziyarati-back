import { DLQ_QUEUES, JOB, JobName } from './queue.constants';
import { JOB_AUTHZ_POLICY } from './job-authorization.constants';
import {
  FEATURE_KEYS,
  FEATURE_REGISTRY,
} from '../modules/subscription-billing/feature-registry';

/**
 * The background half of "no clinic capability silently outside the registry".
 *
 * `controller-entitlement-coverage.spec.ts` proves every HTTP controller either
 * declares a capability or is an explicit, reviewed exemption. This proves the
 * same for background work, which is where the original gap was worst: there
 * was no reference to the access policy anywhere under `src/queue` or
 * `src/worker`, so a queued WhatsApp send, campaign fan-out or AI turn ran
 * happily for a tenant whose capability was switched off, suspended, or never
 * granted.
 *
 * A tenant-tier job with no `featureKey` is therefore a finding by default. The
 * two exemptions below are decisions, and each one is defended.
 */
const TENANT_JOBS_WITHOUT_A_CAPABILITY: ReadonlySet<JobName> = new Set<JobName>(
  [
    // Ships events the tenant was ALREADY entitled to produce. Gating delivery
    // would discard them after the fact, breaking the receiving system's view of
    // the world while preventing nothing — entitlement belongs on the capability
    // that produced the event, and that is where it is enforced.
    JOB.WEBHOOKS_DELIVER,
    // INGEST. Refusing inbound data for a blocked clinic destroys records it
    // never gets to see once access is restored. What the ingested data goes on
    // to DO is gated at the execution seam instead.
    JOB.INTEGRATION_INBOUND,
    // SYNC, same reasoning as WHATSAPP_WEBHOOK_PROCESS/INTEGRATION_INBOUND
    // above: this pulls the clinic's OWN WhatsApp Business App message
    // history/state from Meta. Refusing it for a suspended/unentitled tenant
    // does not protect anything (no send, no AI/messaging spend) — it only
    // leaves the number permanently unsynced once access is restored, and
    // Meta's docs are explicit that a sync cannot simply be re-run later
    // without re-onboarding.
    JOB.WHATSAPP_COEXISTENCE_SYNC,
  ],
);

describe('background job entitlement coverage', () => {
  const entries = Object.entries(JOB_AUTHZ_POLICY) as [
    JobName,
    (typeof JOB_AUTHZ_POLICY)[JobName],
  ][];

  it('every tenant-tier job either declares a capability or is an explicit exemption', () => {
    const ungated = entries
      .filter(
        ([name, policy]) =>
          policy?.tier === 'tenant' &&
          !policy.featureKey &&
          !TENANT_JOBS_WITHOUT_A_CAPABILITY.has(name),
      )
      .map(([name]) => name);

    expect(ungated).toEqual([]);
  });

  it('every declared job capability is a real registry key', () => {
    for (const [, policy] of entries) {
      if (!policy?.featureKey) continue;
      expect(FEATURE_KEYS).toContain(policy.featureKey);
    }
  });

  /**
   * An `alwaysOn` capability is never gated for anyone, so naming one on a job
   * would be a check that can never fail — the appearance of enforcement with
   * none of the substance.
   */
  it('no job gates on an always-on capability', () => {
    for (const [, policy] of entries) {
      if (!policy?.featureKey) continue;
      expect(FEATURE_REGISTRY[policy.featureKey].alwaysOn).not.toBe(true);
    }
  });

  it('keeps the exemption list free of stale entries', () => {
    for (const name of TENANT_JOBS_WITHOUT_A_CAPABILITY) {
      const policy = JOB_AUTHZ_POLICY[name];
      expect(policy).toBeDefined();
      expect(policy?.tier).toBe('tenant');
      expect(policy?.featureKey).toBeUndefined();
    }
  });

  /**
   * `resolveJobAuthzPolicy` fails closed on an unregistered name, and
   * `WorkerAuthorizationService` turns that into a permanent rejection. That is
   * only protective if the registry actually covers the job names the codebase
   * enqueues — otherwise every run of a forgotten job type is a failed job.
   */
  it('registers a policy for every job name a worker can actually run', () => {
    // The four `*.dlq` names are PARKING names: jobs are `.add()`ed to a
    // dead-letter queue for inspection and admin replay, and no `Worker` ever
    // consumes one (see `DLQ_QUEUES` in queue.constants.ts). Nothing calls
    // `resolveJobAuthzPolicy` for them, so their absence from the registry is
    // correct rather than a gap — and asserting the exact set keeps that true:
    // a fifth DLQ, or a real job name slipping in here, fails this test.
    const dlqParks = new Set<string>(DLQ_QUEUES);
    const missing = (Object.values(JOB) as JobName[]).filter(
      (name) => !(name in JOB_AUTHZ_POLICY),
    );
    expect(missing.filter((name) => !dlqParks.has(name))).toEqual([]);
    expect([...missing].sort()).toEqual([...dlqParks].sort());
  });
});

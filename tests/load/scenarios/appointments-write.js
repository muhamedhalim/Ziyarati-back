/**
 * APPOINTMENT WRITE PATH — throughput and race behaviour.
 *
 * Two scenarios, run back to back, because they answer different questions:
 *
 *  1. `throughput` — every VU books its own slot. Measures the real cost of the
 *     booking transaction: ~15-20 round trips held inside ONE transaction
 *     (branch/customer/staff/service validation, the full ~11-query availability
 *     engine, a usage-counter UPDATE, then four INSERTs). Every concurrent
 *     booking for the SAME tenant also queues behind a single usage-counter row
 *     lock, so this is where per-tenant write serialisation shows up.
 *
 *  2. `contention` — every VU aims at ONE slot on ONE staff member. This is the
 *     race-condition probe. Exactly one booking can win; the rest must lose
 *     cleanly with 409 SLOT_ALREADY_BOOKED from the gist exclusion constraint.
 *     What we are checking is that the loser count plus winner count equals the
 *     attempt count — i.e. the constraint holds and no double-booking slips
 *     through under concurrency. A 5xx here, or two winners, would be a defect.
 *
 * SAFETY: creation emits appointment.created, which fans out to notification,
 * reminder, webhook and workflow listeners. In this lab all four are inert —
 * notification_rules / webhook_endpoints / workflows / whatsapp_accounts are
 * empty and no worker process is running, so jobs cannot even be consumed.
 * Verify that before pointing this at any other environment.
 *
 * Every row created carries notes='k6-load-test'; run data/cleanup.sql after.
 */
import exec from 'k6/execution';
import { buildSessions, sessionFor } from '../helpers/auth.js';
import { createAppointment, availabilityWindows } from '../flows/appointments.js';
import { LATENCY } from '../config/thresholds.js';

const RATE = Number(__ENV.RATE || 10);

export const options = {
  scenarios: {
    throughput: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: Math.max(20, RATE * 3),
      maxVUs: 300,
      tags: { step: 'write-throughput' },
      exec: 'throughput',
    },
    contention: {
      executor: 'constant-vus',
      vus: Number(__ENV.CONTEND_VUS || 30),
      duration: '30s',
      startTime: __ENV.CONTEND_START || '3m10s',
      tags: { step: 'write-contention' },
      exec: 'contention',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    // Only the throughput arm has a latency SLO; contention is about
    // correctness under a race, not speed.
    'endpoint_latency{step:write-throughput}': [`p(95)<${LATENCY.write}`],
    'http_5xx': ['count<1'],          // a race must never produce a 500
    'business_check_failed': ['rate<0.01'],
  },
};

export function setup() {
  const sessions = buildSessions();
  console.log(`write: rate=${RATE}/s sessions=${sessions.length}`);
  return { sessions };
}

export function throughput(data) {
  const session = sessionFor(data.sessions, __VU);
  // A real receptionist checks availability before booking; including it keeps
  // the ratio of the (expensive) availability engine to writes realistic.
  if ((__ITER || 0) % 3 === 0) availabilityWindows(session, 'write-throughput', 2);
  createAppointment(session, 'write-throughput', false);
}

export function contention(data) {
  // ALL VUs must share ONE session here. Spreading them across sessions puts
  // each VU on a different TENANT — and therefore a different staff member —
  // so the exclusion constraint has nothing to arbitrate and the "race" probe
  // silently measures nothing (it reported 1441 creates and 0 conflicts before
  // this was fixed). One session means one tenant, one staff member, one slot:
  // exactly one winner is then the correct outcome.
  createAppointment(data.sessions[0], 'write-contention', true);
}

export function handleSummary(data) {
  const g = (n) => (data.metrics[n] ? data.metrics[n].values.count : 0);
  const created = g('appt_created');
  const conflicts = g('appt_conflict_409');
  const out = {
    generatedAt: new Date().toISOString(),
    rate: RATE,
    created,
    conflict_409: conflicts,
    quota_422: g('appt_quota_422'),
    server_5xx: g('http_5xx'),
    timeouts: g('http_timeout_or_conn'),
    write_p95_ms: data.metrics['endpoint_latency{step:write-throughput}']
      ? data.metrics['endpoint_latency{step:write-throughput}'].values['p(95)'] : null,
    note: 'contention arm is expected to produce many 409 SLOT_ALREADY_BOOKED — '
      + 'exactly one winner per contested slot is correct behaviour, not a failure.',
  };
  return {
    stdout: `\n  writes: ${created} created, ${conflicts} conflicts, `
      + `${out.server_5xx} 5xx\n  report: tests/load/reports/appointments-write.json\n\n`,
    '/reports/appointments-write.json': JSON.stringify(out, null, 2),
  };
}

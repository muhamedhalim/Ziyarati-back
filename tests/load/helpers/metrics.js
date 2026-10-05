/**
 * Custom metrics shared by every scenario.
 *
 * `endpointLatency` is tagged with {endpoint, step} so the progressive sweep can
 * answer "which endpoint degraded first, and at what arrival rate" directly from
 * k6 output instead of from inference.
 */
import { Trend, Rate, Counter } from 'k6/metrics';
import { recordBucket } from './buckets.js';

export const endpointLatency = new Trend('endpoint_latency', true);
export const journeyLatency = new Trend('journey_latency', true);

/** 5xx as a RATE, so the P0 threshold ("unexpected 5xx above the agreed limit") is expressible. */
export const serverErrorRate = new Rate('server_error_rate');

export const rateLimited = new Counter('http_429_rate_limited');
export const serverErrors = new Counter('http_5xx');
export const clientErrors = new Counter('http_4xx');
export const timeouts = new Counter('http_timeout_or_conn');

/** Appointment-write outcomes, kept distinct from failures. */
export const apptCreated = new Counter('appt_created');
export const apptConflict409 = new Counter('appt_conflict_409');
export const apptQuota422 = new Counter('appt_quota_422');

/**
 * Campaign business outcomes. Each is an EXPECTED, countable result — never an
 * error — so a 409 storm or a drained pool is visible without polluting
 * `http_req_failed`. (Counters are additive, so they merge across generators.)
 */
export const apptSlotTaken = new Counter('appt_conflict_slot_taken');        // 23P01 -> SLOT_ALREADY_BOOKED
export const apptNotAvailable = new Counter('appt_conflict_not_available');  // pre-check STAFF_NOT_AVAILABLE
export const apptRescheduled = new Counter('appt_rescheduled');
export const apptCancelled = new Counter('appt_cancelled');
export const queueCycles = new Counter('queue_cycle_completed');
export const queueConflict409 = new Counter('queue_conflict_409');
export const authLoginOk = new Counter('auth_login_ok');
export const authLoginRejected = new Counter('auth_login_rejected');
export const authLockout429 = new Counter('auth_lockout_429');
export const refreshOk = new Counter('auth_refresh_ok');
export const refreshRejected = new Counter('auth_refresh_rejected');
export const payRedirect = new Counter('pay_checkout_redirect');
export const payProcessing = new Counter('pay_checkout_processing');
export const payOther = new Counter('pay_checkout_other');
export const webhookAccepted = new Counter('webhook_accepted');
export const webhookDuplicate = new Counter('webhook_deduplicated');
export const webhookRejected = new Counter('webhook_rejected');
export const aiTurnDone = new Counter('ai_turn_done');
export const aiTurnRateLimited = new Counter('ai_turn_rate_limited');
export const aiTurnError = new Counter('ai_turn_error');
export const wsConnectFail = new Counter('ws_connect_failed');
export const partnerRateLimited = new Counter('partner_rate_limited');
export const partnerWriteOutcome = new Counter('partner_write_outcome');

/** Records one response into the tagged metric set. Returns true if 2xx. */
export function observe(res, endpoint, step) {
  const tags = { endpoint, step };
  endpointLatency.add(res.timings.duration, tags);
  recordBucket(res.timings.duration, step, endpoint, res.status);
  serverErrorRate.add(res.status >= 500);

  if (res.status === 0) { timeouts.add(1, tags); return false; }
  if (res.status === 429) { rateLimited.add(1, tags); return false; }
  if (res.status >= 500) { serverErrors.add(1, tags); return false; }
  if (res.status >= 400) { clientErrors.add(1, tags); return false; }
  return true;
}

/** Records an appointment-create outcome. */
export function observeCreate(res, step) {
  const tags = { endpoint: 'appointments:create', step };
  endpointLatency.add(res.timings.duration, tags);
  recordBucket(res.timings.duration, step, 'appointments:create', res.status);
  serverErrorRate.add(res.status >= 500);
  if (res.status === 201) { apptCreated.add(1, tags); return true; }
  if (res.status === 409) { apptConflict409.add(1, tags); return true; }
  if (res.status === 422) { apptQuota422.add(1, tags); return false; }
  if (res.status === 0) { timeouts.add(1, tags); return false; }
  if (res.status >= 500) { serverErrors.add(1, tags); return false; }
  clientErrors.add(1, tags);
  return false;
}

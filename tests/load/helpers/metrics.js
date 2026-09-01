/**
 * Custom metrics shared by every scenario.
 *
 * `endpointLatency` is tagged with {endpoint, step} so the progressive sweep can
 * answer "which endpoint degraded first, and at what arrival rate" directly from
 * k6 output instead of from inference.
 */
import { Trend, Rate, Counter } from 'k6/metrics';

export const endpointLatency = new Trend('endpoint_latency', true);
export const journeyLatency = new Trend('journey_latency', true);

export const rateLimited = new Counter('http_429_rate_limited');
export const serverErrors = new Counter('http_5xx');
export const clientErrors = new Counter('http_4xx');
export const timeouts = new Counter('http_timeout_or_conn');

/** Appointment-write outcomes, kept distinct from failures. */
export const apptCreated = new Counter('appt_created');
export const apptConflict409 = new Counter('appt_conflict_409');
export const apptQuota422 = new Counter('appt_quota_422');

/** Records one response into the tagged metric set. Returns true if 2xx. */
export function observe(res, endpoint, step) {
  const tags = { endpoint, step };
  endpointLatency.add(res.timings.duration, tags);

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
  if (res.status === 201) { apptCreated.add(1, tags); return true; }
  if (res.status === 409) { apptConflict409.add(1, tags); return true; }
  if (res.status === 422) { apptQuota422.add(1, tags); return false; }
  if (res.status === 0) { timeouts.add(1, tags); return false; }
  if (res.status >= 500) { serverErrors.add(1, tags); return false; }
  clientErrors.add(1, tags);
  return false;
}

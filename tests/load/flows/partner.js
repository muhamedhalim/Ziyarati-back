/**
 * Partner / developer API (API-key authenticated) and the inbound signed webhook.
 *
 * Per-request cost the guard chain adds for an API key: one UNCACHED api_keys
 * lookup, one Redis token-bucket (default 120/min per key, FAILS OPEN), one
 * UNCACHED tenant lookup, then feature/subscription checks. Writes are admitted
 * through Redis buckets that FAIL CLOSED (503) when Redis errors.
 *
 * pack-partner.json: [{ tenantId, apiKey, connectionId, branchId, staffId,
 *   customerId, endpointId, endpointSecret }]   — SECRETS: gitignored, never printed.
 *
 * Writes are `POST .../upsert` with body { connectionId, externalId, data }.
 * externalId is unique per iteration for creates; services use a FIXED external id
 * so the second hit exercises the update/link path and the id-map instead of
 * always inserting. 200 `outcome:'conflicted'` is a valid, countable result.
 */
import http from 'k6/http';
import { BASE } from '../helpers/auth.js';
import { observe, partnerRateLimited, partnerWriteOutcome, webhookAccepted, webhookDuplicate, webhookRejected } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { pack } from '../helpers/sessions.js';
import { inboundV2Headers } from '../helpers/signing.js';

const KEYS = pack('partner');
const EXPECT = http.expectedStatuses({ min: 200, max: 299 }, 429);

let _mine;
function mine() {
  if (_mine !== undefined) return _mine;
  _mine = KEYS.length ? KEYS[(__VU * 7919) % KEYS.length] : null;
  return _mine;
}

function hdr(k, extra) {
  return Object.assign({ 'X-API-Key': k.apiKey, 'Content-Type': 'application/json' }, extra || {});
}

function get(k, path, endpoint, step) {
  const res = http.get(`${BASE}/api/v1/integrations/${path}`, {
    headers: hdr(k), tags: { step, name: `partner/${endpoint}` }, responseCallback: EXPECT,
  });
  observe(res, endpoint, step);
  if (res.status === 429) partnerRateLimited.add(1, { endpoint, step });
  return res;
}

/** A partner system's read sync. */
export function partnerReads(step) {
  const k = mine();
  if (!k) return null;
  const me = get(k, 'me', 'partner:me', step);
  businessErrors.add(!(me.status === 200 || me.status === 429), { step });
  get(k, 'appointments?page=1&limit=20', 'partner:appointments', step);
  get(k, 'customers?page=1&limit=20', 'partner:customers', step);
  get(k, 'services?page=1&limit=20', 'partner:services', step);
  get(k, 'staff?page=1&limit=20', 'partner:staff', step);
  const d = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  return get(k, `availability?branchId=${k.branchId}&staffId=${k.staffId}&date=${d}`, 'partner:availability', step);
}

function upsert(k, resource, externalId, data, idemKey, step) {
  const extra = idemKey ? { 'Idempotency-Key': idemKey } : {};
  const res = http.post(`${BASE}/api/v1/integrations/${resource}/upsert`,
    JSON.stringify({ connectionId: k.connectionId, externalId, data }), {
      headers: hdr(k, extra), tags: { step, name: `partner/${resource}-upsert` }, responseCallback: EXPECT,
    });
  observe(res, `partner:${resource}:upsert`, step);
  if (res.status === 429) partnerRateLimited.add(1, { step });
  if (res.status === 200) {
    try { partnerWriteOutcome.add(1, { resource, outcome: res.json().outcome || 'unknown' }); } catch (e) { /* ignore */ }
  }
  return res;
}

/** A partner system pushing records. Customers are unique per iteration (create path). */
export function partnerWrites(step) {
  const k = mine();
  if (!k) return null;
  const n = `${__VU}-${__ITER || 0}-${Math.floor(Math.random() * 1e6)}`;
  // Unique per call, never per (VU, iter): the API answers 409 CONFLICT when a phone already belongs to a
  // different external id, so a deterministic phone collides with the previous run. 12 random digits.
  const phone = `+966${Math.floor(1e11 + Math.random() * 9e11)}`;
  const r1 = upsert(k, 'customers', `lt-c-${n}`, {
    phone, email: `lt.${n}@lab.test`, full_name: `Partner Customer ${n}`,
  }, `lt-idem-${n}`, step);
  businessErrors.add(!(r1.status === 200 || r1.status === 429), { step });
  // Fixed external id: after the first hit this is the update/link path.
  upsert(k, 'services', `lt-svc-${k.tenantId}`, { name: 'LT Partner Service', durationMinutes: 30, basePrice: 100 }, null, step);
  // Replaying the SAME idempotency key + payload must return the stored result.
  return upsert(k, 'customers', `lt-c-${n}`, {
    phone, email: `lt.${n}@lab.test`, full_name: `Partner Customer ${n}`,
  }, `lt-idem-${n}`, step);
}

/**
 * Inbound signed webhook (`hmac_sha256_timestamped_v2`). A fresh event id per
 * delivery. `duplicate=true` re-sends the SAME event id to measure dedupe (200,
 * status:'duplicate'). 202 = accepted; processing is asynchronous (outbox ->
 * worker), so acceptance latency is reported separately from processing.
 */
export function partnerInbound(step, duplicate) {
  const k = mine();
  if (!k || !k.endpointSecret) return null;
  const eventId = `lt-evt-${__VU}-${__ITER || 0}-${Math.floor(Math.random() * 1e9)}`;
  const body = JSON.stringify({
    externalId: `lt-in-${__VU}-${__ITER || 0}`,
    data: { phone: `+9665${String(20000000 + ((__VU * 977 + (__ITER || 0)) % 79999999))}`, email: `in.${eventId}@lab.test`, full_name: 'Inbound Partner' },
  });
  const send = () => http.post(`${BASE}/api/v1/integrations/inbound/${k.connectionId}`, body, {
    headers: inboundV2Headers(k.endpointSecret, eventId, 'customer.upserted', body),
    tags: { step, name: 'partner/inbound' },
    responseCallback: http.expectedStatuses(200, 202, 403, 422, 503),
  });
  const res = send();
  observe(res, 'partner:inbound', step);
  if (res.status === 202) webhookAccepted.add(1, { kind: 'inbound', step });
  else webhookRejected.add(1, { kind: 'inbound', status: String(res.status), step });
  if (duplicate) {
    const dup = send();
    observe(dup, 'partner:inbound:dup', step);
    if (dup.status === 200) webhookDuplicate.add(1, { kind: 'inbound', step });
  }
  businessErrors.add(!(res.status === 202), { step });
  return res;
}

#!/usr/bin/env node
/**
 * LAB TAP STUB — an out-of-process HTTP stand-in for api.tap.company, so the payment
 * scenarios exercise the REAL Tap code path (TapApiClient, provider mapping, webhook
 * re-fetch, reconciliation) without any real provider, key, card or money.
 *
 * Why not the e2e `TapSandbox`? It is an in-process Jest double injected at the
 * TapApiClient boundary; a load test needs a real HTTP server the API talks to over a
 * socket. Response SHAPES are copied from that double (test/utils/tap-e2e.ts), which is
 * itself kept honest against the real sandbox by scripts/tap-sandbox/.
 *
 * SAFETY: binds to 127.0.0.1 only; never makes an outbound request; carries no secret
 * (it does not validate the Bearer key); refuses to start if TAP_STUB_BIND is not loopback.
 *
 * Behaviour (what the app consumes):
 *   POST /v2/charges           creates a charge (status INITIATED, transaction.url https),
 *                              echoes merchant.id / reference.transaction / metadata, dedupes
 *                              on reference.idempotent, and COUNTS creates per
 *                              reference.transaction — a count > 1 for one booking with
 *                              DIFFERENT idempotency keys is a double charge (see /__admin/stats)
 *   GET  /v2/charges/:id       a created charge (INITIATED, or CAPTURED if captureOnGet),
 *                              or a PRELOADED charge (CAPTURED, from the pay-webhooks /
 *                              pay-returns packs): the registry the webhook/return scenarios use
 *   POST /v2/charges/list      charges by reference.transaction
 *   POST /v2/charges/download  CSV with the documented header and NO rows; has_more=false
 *   POST /v2/payouts/list      {payouts: []}
 *   POST /v2/refunds           idempotent by reference.idempotent; status per config
 *   GET  /v2/refunds/:id       the refund
 *   POST /v2/tokens            {id: tok_*, status: ACTIVE}
 *   DELETE /v2/card/:c/:id     {deleted: true}
 *   POST /v3/lead, /v3/connect minimal onboarding answers
 *
 * ADMIN (same loopback port, /__admin/*):
 *   GET  /__admin/stats        counters + double-charge report (JSON)
 *   POST /__admin/config       {latencyMs, jitterMs, failRate, failStatus, captureOnGet,
 *                               mitStatus, refundStatus, hangRate}
 *   POST /__admin/reset        clears counters and created charges (keeps the preload)
 *
 * Fault injection used by lab/chaos.mjs: latencyMs (slow Tap), failRate+failStatus (5xx/429),
 * hangRate (accept the request and never answer: exercises TAP_REQUEST_TIMEOUT_MS).
 *
 * Usage: node tap-stub.mjs [--port 4477] [--pack-dir tests/load/data/generated]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', process.env.TAP_STUB_PORT || 4477));
const BIND = process.env.TAP_STUB_BIND || '127.0.0.1';
const PACK_DIR = arg('pack-dir', null);

if (!['127.0.0.1', '::1', 'localhost'].includes(BIND)) {
  console.error(`tap-stub: refusing to bind ${BIND} — the stub is loopback-only by design`);
  process.exit(2);
}

const REPORT_COLUMNS = ['payout_id', 'settlement_id', 'charge_id', 'currency', 'amount', 'status', 'authorization_id',
  'status_code', 'status_message', 'gateway_code', 'gateway_message', 'issuer_code', 'issuer_message', 'charge_date',
  'capture_date', 'post_date', 'settlement_date', 'payout_date', 'track_id', 'reference_gateway', 'reference_acquirer',
  'reference_transaction', 'reference_order', 'receipt', 'customer_id', 'customer_name', 'customer_phone_code',
  'customer_phone', 'customer_email', 'first_eight', 'last_four', 'issuer_country', 'payment_method', 'payment_scheme',
  'payment_type', 'merchant_id', 'product', 'post_currency', 'post_amount', 'fee', 'fee_vat', 'net_amount',
  'metadata_1', 'metadata_2', 'metadata_3', 'metadata_4', 'metadata_5'];

const uid = () => crypto.randomUUID().replace(/-/g, '');

const state = {
  cfg: { latencyMs: 0, jitterMs: 0, failRate: 0, failStatus: 503, hangRate: 0, captureOnGet: false, mitStatus: 'CAPTURED', refundStatus: 'REFUNDED' },
  charges: new Map(),            // created via POST
  preload: new Map(),            // id -> { amount, currency, paymentId }  (CAPTURED)
  chargesByIdempotent: new Map(),
  perReference: new Map(),       // reference.transaction -> Set(idempotency keys)
  refunds: new Map(),
  refundsByIdempotent: new Map(),
  stats: { requests: 0, chargeCreates: 0, chargeCreateDeduped: 0, chargeGets: 0, preloadGets: 0, refundCreates: 0,
    refundGets: 0, tokens: 0, injectedFailures: 0, injectedHangs: 0, notFound: 0 },
};

function loadPreload() {
  if (!PACK_DIR) return;
  for (const f of ['pack-pay-webhooks.json', 'pack-pay-returns.json']) {
    const p = path.join(PACK_DIR, f);
    if (!fs.existsSync(p)) continue;
    for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) {
      state.preload.set(r.chargeId, { amount: r.amount, currency: r.currency || 'SAR', paymentId: r.paymentId || null });
    }
  }
  console.log(`tap-stub: preloaded ${state.preload.size} charges from ${PACK_DIR}`);
}

const json = (res, status, body, headers) => {
  const s = JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }, headers || {}));
  res.end(s);
};
const tapError = (res, status, code, description) => json(res, status, { errors: [{ code: String(code), description }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function chargeView(c) { return JSON.parse(JSON.stringify(c)); }

function capturedPreload(id, p) {
  return {
    id, object: 'charge', status: 'CAPTURED', amount: Number(p.amount), currency: p.currency,
    reference: { transaction: p.paymentId, gateway: 'GW1', payment: 'PAY1' },
    metadata: p.paymentId ? { udf1: p.paymentId } : {},
    source: { payment_method: 'MADA' },
    transaction: { created: String(Date.now()) },
  };
}

function newRefund(body, status) {
  const r = {
    id: `re_${uid()}`, object: 'refund', status, amount: Number(body.amount), currency: body.currency,
    charge_id: body.charge_id, reference: { merchant: body.reference && body.reference.merchant }, created: String(Date.now()),
  };
  state.refunds.set(r.id, r);
  if (body.reference && body.reference.idempotent) state.refundsByIdempotent.set(body.reference.idempotent, r.id);
  return r;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${BIND}`);
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  // ---------------- admin (never subject to fault injection)
  if (p.startsWith('/__admin')) {
    if (p === '/__admin/stats' && m === 'GET') {
      const doubles = [];
      for (const [ref, keys] of state.perReference) if (keys.size > 1) doubles.push({ reference: ref, creates: keys.size });
      return json(res, 200, { stats: state.stats, cfg: state.cfg, charges: state.charges.size, preloaded: state.preload.size,
        referencesWithMultipleCharges: doubles.length, doubleCharges: doubles.slice(0, 200) });
    }
    if (p === '/__admin/config' && m === 'POST') { Object.assign(state.cfg, await readBody(req)); return json(res, 200, state.cfg); }
    if (p === '/__admin/preload' && m === 'POST') {
      // Rows: [{ chargeId, paymentId, amount, currency }] — charges Tap should report CAPTURED. Used by
      // build-packs.mjs, which generates the packs AFTER the stub is already running.
      const body = await readBody(req);
      for (const r of body.rows || []) state.preload.set(r.chargeId, { amount: r.amount, currency: r.currency || 'SAR', paymentId: r.paymentId || null });
      return json(res, 200, { preloaded: state.preload.size });
    }
    if (p === '/__admin/reset' && m === 'POST') {
      state.charges.clear(); state.chargesByIdempotent.clear(); state.perReference.clear(); state.refunds.clear(); state.refundsByIdempotent.clear();
      for (const k of Object.keys(state.stats)) state.stats[k] = 0;
      return json(res, 200, { reset: true });
    }
    return json(res, 404, { error: 'unknown admin route' });
  }

  state.stats.requests++;

  // ---------------- fault injection (slow / failing / hanging Tap)
  const { latencyMs, jitterMs, failRate, failStatus, hangRate } = state.cfg;
  if (hangRate > 0 && Math.random() < hangRate) { state.stats.injectedHangs++; return; } // never answers
  if (latencyMs > 0 || jitterMs > 0) await sleep(latencyMs + Math.random() * jitterMs);
  if (failRate > 0 && Math.random() < failRate) {
    state.stats.injectedFailures++;
    return tapError(res, failStatus, failStatus === 429 ? '1429' : '1503', 'injected failure');
  }

  // ---------------- charges
  if (p === '/v2/charges' && m === 'POST') {
    const body = await readBody(req);
    const idem = body.reference && body.reference.idempotent;
    if (idem && state.chargesByIdempotent.has(idem)) {
      state.stats.chargeCreateDeduped++;
      return json(res, 200, chargeView(state.charges.get(state.chargesByIdempotent.get(idem))));
    }
    const id = `chg_${uid()}`;
    const merchantInitiated = body.customer_initiated === false;
    const charge = {
      id, object: 'charge',
      status: merchantInitiated ? state.cfg.mitStatus : 'INITIATED',
      amount: Number(body.amount), currency: body.currency,
      reference: { transaction: body.reference && body.reference.transaction },
      metadata: body.metadata, merchant: body.merchant,
      save_card: body.save_card === true, customer_initiated: body.customer_initiated,
      transaction: { created: String(Date.now()), url: `https://checkout.tap.test/${id}` },
    };
    if (merchantInitiated) {
      charge.customer = { id: body.customer && body.customer.id };
      charge.payment_agreement = body.payment_agreement;
      if (state.cfg.mitStatus === 'CAPTURED') {
        charge.reference = Object.assign({}, charge.reference, { gateway: 'GW1', payment: 'PAY1' });
        charge.source = { payment_method: 'VISA' };
      } else if (state.cfg.mitStatus === 'DECLINED') charge.response = { code: '510' };
    }
    state.charges.set(id, charge);
    if (idem) state.chargesByIdempotent.set(idem, id);
    state.stats.chargeCreates++;
    const ref = charge.reference.transaction || `anon:${id}`;
    if (!state.perReference.has(ref)) state.perReference.set(ref, new Set());
    state.perReference.get(ref).add(idem || id);
    return json(res, 200, chargeView(charge));
  }
  let mm;
  if ((mm = /^\/v2\/charges\/([^/]+)$/.exec(p)) && m === 'GET') {
    state.stats.chargeGets++;
    const id = decodeURIComponent(mm[1]);
    const pre0 = state.preload.get(id);
    if (pre0) { state.stats.preloadGets++; return json(res, 200, capturedPreload(id, pre0)); }
    const created = state.charges.get(id);
    if (created) {
      if (state.cfg.captureOnGet && created.status === 'INITIATED') {
        Object.assign(created, { status: 'CAPTURED', reference: Object.assign({}, created.reference, { gateway: 'GW1', payment: 'PAY1' }), source: { payment_method: 'MADA' } });
      }
      return json(res, 200, chargeView(created));
    }
    const pre = state.preload.get(id);
    if (pre) { state.stats.preloadGets++; return json(res, 200, capturedPreload(id, pre)); }
    state.stats.notFound++;
    return tapError(res, 404, '1142', 'charge not found');
  }
  if (p === '/v2/charges/list' && m === 'POST') {
    const body = await readBody(req);
    const wanted = (body.reference && body.reference.transaction) || [];
    const found = [...state.charges.values()].filter((c) => wanted.includes(c.reference && c.reference.transaction));
    return json(res, 200, { object: 'list', has_more: false, count: found.length, charges: found.map(chargeView) });
  }
  if (p === '/v2/charges/download' && m === 'POST') {
    await readBody(req);
    const csv = REPORT_COLUMNS.join(',') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Length': Buffer.byteLength(csv), has_more: 'false' });
    return res.end(csv);
  }
  if (p === '/v2/payouts/list' && m === 'POST') {
    await readBody(req);
    return json(res, 200, { object: 'list', has_more: false, count: 0, payouts: [] });
  }

  // ---------------- refunds
  if (p === '/v2/refunds' && m === 'POST') {
    const body = await readBody(req);
    state.stats.refundCreates++;
    const seen = body.reference && body.reference.idempotent && state.refundsByIdempotent.get(body.reference.idempotent);
    if (seen) return json(res, 200, state.refunds.get(seen));
    return json(res, 200, newRefund(body, state.cfg.refundStatus));
  }
  if ((mm = /^\/v2\/refunds\/([^/]+)$/.exec(p)) && m === 'GET') {
    state.stats.refundGets++;
    const r = state.refunds.get(decodeURIComponent(mm[1]));
    return r ? json(res, 200, r) : tapError(res, 404, '1142', 'refund not found');
  }

  // ---------------- saved cards, onboarding
  if (p === '/v2/tokens' && m === 'POST') { await readBody(req); state.stats.tokens++; return json(res, 200, { id: `tok_${uid()}`, status: 'ACTIVE' }); }
  if (/^\/v2\/card\/[^/]+\/[^/]+$/.test(p) && m === 'DELETE') return json(res, 200, { deleted: true });
  if (p === '/v3/lead' && m === 'POST') { await readBody(req); return json(res, 200, { id: `led_${uid()}`, object: 'lead' }); }
  if (p === '/v3/connect' && m === 'POST') { await readBody(req); const id = `connect_${uid()}`; return json(res, 200, { id, connect: { url: `https://connect.tap.test/${id}` } }); }

  state.stats.notFound++;
  return tapError(res, 404, '1404', `stub does not implement ${m} ${p}`);
}

loadPreload();
const server = http.createServer((req, res) => { route(req, res).catch((e) => { try { json(res, 500, { errors: [{ code: '1500', description: String(e && e.message) }] }); } catch { /* socket gone */ } }); });
server.keepAliveTimeout = 65000;
server.listen(PORT, BIND, () => console.log(`tap-stub listening on http://${BIND}:${PORT} (loopback only, no outbound calls)`));

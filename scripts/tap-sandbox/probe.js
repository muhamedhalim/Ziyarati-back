#!/usr/bin/env node
/**
 * Tap SANDBOX probe (Phase 7) — card-less, tunnel-less validation of OUR Tap code
 * against the real https://api.tap.company, using the compiled adapter classes
 * (so what is validated is the code that ships, not a hand-rolled fetch).
 *
 *   npm run build            # the probe loads dist/
 *   node scripts/tap-sandbox/probe.js [--out results.json] [--state state.json]
 *
 * Tap lists a NEW charge only after minutes (measured: > 2.5 min), so the list/download
 * lookups of a charge made by this very run answer 400/1249 "Charges not found". Pass
 * the same --state file on a later run and those probes check the AGED charge instead.
 *
 * SAFETY (all enforced below, before any request):
 *   - TAP_ENV must be `sandbox` and the key must start with `sk_test_` — the live
 *     keys in .env can never be used by this script.
 *   - Reads the key from .env through PaymentsConfig; NEVER prints it. Output is
 *     structural: HTTP status, Tap error code/description, key names + types, and
 *     a few non-sensitive values (ids, statuses, hosts).
 *   - Creates only UNPAID sandbox charges (INITIATED, expire on their own). The
 *     onboarding calls (Lead/Connect) are sent EMPTY or with a fake id, so no
 *     lead/merchant is created — the answer is the validation error.
 *   - Customer data is fake (`probe@example.com`, a fake phone).
 *
 * What it CANNOT do (needs a human card entry and/or a public tunnel):
 *   a captured charge, refunds of a captured charge, merchant-initiated charges,
 *   webhook delivery + `hashstring` semantics. See scripts/tap-sandbox/README.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, '.env') });

// ── guards ──────────────────────────────────────────────────────────────────
process.env.TAP_ENV = 'sandbox';
const key = process.env.TAP_TEST_SECRET_KEY || '';
if (!key.startsWith('sk_test_')) {
  console.error('Refusing to run: TAP_TEST_SECRET_KEY is missing or is not an sk_test_ key.');
  process.exit(2);
}
// Never inherit a webhook URL / platform id / expiry from .env: each probe sets its own.
for (const k of ['TAP_WEBHOOK_URL', 'TAP_PLATFORM_ID', 'TAP_CHARGE_EXPIRY_MINUTES', 'TAP_API_BASE']) {
  delete process.env[k];
}

const dist = (p) => require(path.join(root, 'dist', 'src', 'modules', 'payments', p));
let PaymentsConfig, TapApiClient, TapGatewayProvider, mapChargeStatus, mapRefundStatus;
try {
  ({ PaymentsConfig } = dist('payments.config'));
  ({ TapApiClient } = dist('providers/tap/tap-api.client'));
  ({ TapGatewayProvider } = dist('providers/tap/tap-gateway.provider'));
  ({ mapChargeStatus, mapRefundStatus } = dist('providers/tap/tap-status.mapper'));
} catch (e) {
  console.error('dist/ is missing or stale — run `npm run build` first.', e.message);
  process.exit(2);
}

const config = new PaymentsConfig({ get: (k) => process.env[k] });
const client = new TapApiClient(config);
const provider = new TapGatewayProvider(config, client);

const argState = process.argv.indexOf('--state');
const stateFile = argState > 0 ? process.argv[argState + 1] : null;
let prior = null;
try {
  prior = stateFile ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
} catch {
  prior = null;
}
const argOut = process.argv.indexOf('--out');
const outFile = argOut > 0 ? process.argv[argOut + 1] : null;

// ── helpers ─────────────────────────────────────────────────────────────────
const results = [];
const SENSITIVE = /^(sk_|pk_|tok_)/;

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 3 ? 'array' : v.length ? [shape(v[0], depth + 1)] : [];
  if (typeof v === 'object') {
    if (depth > 3) return 'object';
    const o = {};
    for (const k of Object.keys(v)) o[k] = shape(v[k], depth + 1);
    return o;
  }
  return typeof v;
}

function safeValue(v) {
  if (typeof v === 'string' && SENSITIVE.test(v)) return '[redacted]';
  return v;
}

function urlHostPath(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.split('/').slice(0, 2).join('/')}/…`;
  } catch {
    return u ? '[unparseable]' : undefined;
  }
}

async function probe(label, question, fn) {
  const row = { label, question };
  try {
    Object.assign(row, await fn());
  } catch (e) {
    row.exception = String(e && e.message ? e.message : e).slice(0, 200);
  }
  results.push(row);
  const head = row.exception
    ? `EXCEPTION ${row.exception}`
    : `http=${row.http ?? '-'} ${row.code ? 'code=' + row.code : ''} ${row.verdict ?? ''}`;
  console.log(`\n▶ ${label}\n  ${question}\n  ${head}`);
  if (row.notes) for (const n of [].concat(row.notes)) console.log(`  · ${n}`);
}

const resp = (res) => ({
  http: res.status,
  ok: res.ok,
  transient: res.transient,
  code: res.errorCode,
  description: res.errorDescription,
});

function baseRequest(overrides = {}) {
  return {
    paymentId: randomUUID(),
    tenantId: randomUUID(),
    amount: 1,
    currency: 'SAR',
    description: 'ZiyaraTech sandbox probe',
    returnUrl: 'https://example.com/app/billing?checkout=return',
    payee: 'platform',
    customer: { firstName: 'Probe', email: 'probe@example.com' },
    ...overrides,
  };
}

async function rawCreate(request, mutate) {
  const body = provider.chargeBody(request);
  if (mutate) mutate(body);
  const res = await client.createCharge(body);
  return { res, body };
}

function chargeSummary(c) {
  if (!c) return undefined;
  return {
    id: c.id,
    object: c.object,
    status: c.status,
    amount: c.amount,
    currency: c.currency,
    live_mode: c.live_mode,
    topLevelKeys: Object.keys(c),
    transactionKeys: c.transaction ? Object.keys(c.transaction) : undefined,
    transactionUrlHost: urlHostPath(c.transaction?.url),
    transactionExpiry: c.transaction?.expiry,
    reference: c.reference,
    metadata: c.metadata,
    redirect: c.redirect ? { url: c.redirect.url, status: c.redirect.status } : undefined,
    post: c.post,
    merchantKeys: c.merchant ? Object.keys(c.merchant) : undefined,
    customerKeys: c.customer ? Object.keys(c.customer) : undefined,
    sourceKeys: c.source ? Object.keys(c.source) : undefined,
    response: c.response,
    save_card: c.save_card,
    threeDSecure: c.threeDSecure,
  };
}

// ── probes ──────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Tap sandbox probe — env=${config.tapEnv}, key=sk_test_… (not printed), merchant=${config.tapMerchantId ?? '(none)'}`);
  const created = {};

  await probe('A1 unknown charge id', 'What do an unknown id and the auth path look like? (401 would mean the key is rejected)', async () => {
    const res = await client.getCharge('chg_TS00000000000000000000');
    return { ...resp(res), jsonKeys: res.json ? Object.keys(res.json) : undefined, verdict: res.status === 401 ? 'KEY REJECTED' : 'key accepted' };
  });

  await probe('B1 create hosted charge (email only)', 'Does Tap accept our exact create body with an e-mail and no phone? (Phase 0 Q7)', async () => {
    const req = baseRequest();
    created.b = req;
    const r = await provider.createPayment(req);
    created.bId = r.gatewayPaymentId;
    return {
      verdict: `${r.status}${r.redirectUrl ? ' + hosted url' : ''}`,
      http: r.status === 'unknown' ? undefined : 200,
      code: r.failureCode,
      notes: [`gatewayPaymentId=${r.gatewayPaymentId}`, `redirect host=${urlHostPath(r.redirectUrl)}`, `correlationId echoed=${r.correlationId === req.paymentId}`],
    };
  });

  await probe('B2 retrieve it', 'Retrieve shape + our status mapping for an unpaid hosted charge', async () => {
    const res = await client.getCharge(created.bId);
    const sum = chargeSummary(res.json);
    return { ...resp(res), charge: sum, verdict: `Tap=${res.json?.status} → mapped=${mapChargeStatus(res.json?.status)}` };
  });

  await probe('B3 idempotent repeat', 'Same reference.idempotent twice → the ORIGINAL charge? (24 h window, Phase 1 §12)', async () => {
    const { res } = await rawCreate(created.b);
    return { ...resp(res), verdict: res.json?.id === created.bId ? 'SAME charge returned' : `DIFFERENT charge (${res.json?.id})`, notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('B4 phone only', 'Does Tap accept a customer with a phone and NO e-mail? (Phase 0 Q7)', async () => {
    const req = baseRequest({ customer: { firstName: 'Probe', phone: { countryCode: '966', number: '512345678' } } });
    const { res } = await rawCreate(req);
    return { ...resp(res), verdict: res.ok ? `accepted (${res.json?.status})` : 'REJECTED', notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('B5 arbitrary metadata keys', 'Are non-udf metadata keys accepted/echoed? (Phase 0 Q6)', async () => {
    const { res } = await rawCreate(baseRequest(), (b) => {
      b.metadata = { ...b.metadata, ziyara_probe: 'x' };
    });
    return { ...resp(res), metadata: res.json?.metadata, verdict: res.ok ? (res.json?.metadata?.ziyara_probe ? 'custom key ECHOED' : 'custom key accepted but NOT echoed') : 'REJECTED', notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('B6 transaction.expiry', 'Is `transaction.expiry` accepted and honoured? (Phase 1 correction 2)', async () => {
    process.env.TAP_CHARGE_EXPIRY_MINUTES = '15';
    try {
      const { res, body } = await rawCreate(baseRequest());
      return { ...resp(res), sent: body.transaction, echoed: res.json?.transaction?.expiry, verdict: res.ok ? 'accepted' : 'REJECTED', notes: res.ok ? undefined : [res.errorDescription] };
    } finally {
      delete process.env.TAP_CHARGE_EXPIRY_MINUTES;
    }
  });

  await probe('B7 post.url', 'Is an https `post.url` accepted on a charge? Echoed?', async () => {
    process.env.TAP_WEBHOOK_URL = 'https://example.com/api/v1/payments/webhooks/tap';
    try {
      const { res } = await rawCreate(baseRequest());
      return { ...resp(res), echoedPost: res.json?.post, verdict: res.ok ? 'accepted' : 'REJECTED', notes: res.ok ? undefined : [res.errorDescription] };
    } finally {
      delete process.env.TAP_WEBHOOK_URL;
    }
  });

  await probe('B7b post.url on http://localhost', 'Does Tap accept a plain-http / localhost post.url? (a dev misconfiguration must fail loudly, not silently drop webhooks)', async () => {
    process.env.TAP_WEBHOOK_URL = 'http://localhost:3001/api/v1/payments/webhooks/tap';
    try {
      const { res } = await rawCreate(baseRequest());
      return { ...resp(res), echoedPost: res.json?.post, verdict: res.ok ? `ACCEPTED (post.status=${res.json?.post?.status})` : 'REJECTED', notes: res.ok ? undefined : [res.errorDescription] };
    } finally {
      delete process.env.TAP_WEBHOOK_URL;
    }
  });

  await probe('B8 save_card:true', 'Is Save Card activated on this account? (1108 = not activated; Phase 0 item 0.5)', async () => {
    const { res } = await rawCreate(baseRequest({ customer: { firstName: 'Probe', email: 'probe@example.com', phone: { countryCode: '966', number: '512345678' } } }), (b) => {
      b.save_card = true;
    });
    return { ...resp(res), verdict: res.ok ? `accepted (${res.json?.status}) → Save Card looks ACTIVE` : `REJECTED → ${res.errorCode ?? res.status}`, notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('B9 src_card source', 'Is the card-only hosted source accepted? (subscription checkout uses it)', async () => {
    const { res } = await rawCreate(baseRequest(), (b) => {
      b.source = { id: 'src_card' };
    });
    return { ...resp(res), verdict: res.ok ? `accepted (${res.json?.status})` : 'REJECTED', notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('C1 find by reference', 'Does `charges/list` filtered by reference.transaction find OUR charge? (REL-002 sweep)', async () => {
    const aged = prior && Date.now() - prior.at > 10 * 60_000 ? prior : null;
    const found = await provider.findPaymentByReference(aged ? aged.paymentId : created.b.paymentId);
    const missing = await provider.findPaymentByReference(randomUUID());
    return { verdict: `${aged ? 'AGED' : 'fresh (listing lag expected)'} charge → ${found.status}; random → ${missing.status}`, notes: [`found id=${found.result?.gatewayPaymentId}`, `status=${found.result?.status}`] };
  });

  await probe('C2 charges/list shapes', 'Which request shapes does charges/list accept? (period/limit/status)', async () => {
    const now = Date.now();
    const a = await client.listCharges({ period: { date: { from: String(now - 3600_000), to: String(now) } }, limit: 5 });
    const b = await client.listCharges({ period: { date: { from: now - 3600_000, to: now } }, limit: 5 });
    return {
      verdict: `period as strings → ${a.status} ${a.errorCode ?? ''}; as numbers → ${b.status} ${b.errorCode ?? ''}`,
      listKeys: a.json ? Object.keys(a.json) : undefined,
      chargeCount: a.json?.charges?.length,
      firstChargeKeys: a.json?.charges?.[0] ? Object.keys(a.json.charges[0]) : undefined,
      notes: [a.errorDescription, b.errorDescription].filter(Boolean),
    };
  });

  await probe('D1 charges/download (our request)', 'Does the reconciliation download request work? CSV header, units, paging headers (Phase 5 §6.2-3)', async () => {
    const now = Date.now();
    const res = await client.downloadCharges({
      period: { date: { from: String(now - 7 * 24 * 3600_000), to: String(now) }, type: 'CHARGE' },
      merchants: [config.tapMerchantId],
      limit: 200,
      starting_after: '',
    });
    const text = typeof res.json === 'string' ? res.json : '';
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines[0];
    const out = { ...resp(res), contentLength: text.length, rowCount: Math.max(lines.length - 1, 0), header, pagingHeaders: { has_more: res.headers?.has_more, last_charge_id: res.headers?.last_charge_id ? '[present]' : undefined }, verdict: res.ok ? `CSV ${lines.length - 1} row(s)` : 'REJECTED' };
    if (lines[1] && header) {
      const cols = header.split(',').map((s) => s.replace(/^"|"$/g, ''));
      const vals = lines[1].split(',').map((s) => s.replace(/^"|"$/g, ''));
      const pick = /(^|_)(amount|fee|fee_vat|net_amount|status|payout_id|merchant_id|currency|settlement_id)$|date/i;
      out.firstRow = Object.fromEntries(cols.map((c, i) => [c, vals[i]]).filter(([c]) => pick.test(c)));
    }
    if (!res.ok) out.notes = [res.errorDescription];
    return out;
  });

  await probe('D2 payouts/list (our request)', 'Does payouts/list work for the platform merchant? statuses/units (Phase 5 §6.4)', async () => {
    const now = Date.now();
    const res = await client.listPayouts({ period: { date: { from: String(now - 29 * 24 * 3600_000), to: String(now) } }, merchants: [config.tapMerchantId], limit: 50 });
    return { ...resp(res), listKeys: res.json ? Object.keys(res.json) : undefined, payoutCount: res.json?.payouts?.length, firstPayoutKeys: res.json?.payouts?.[0] ? Object.keys(res.json.payouts[0]) : undefined, statuses: [...new Set((res.json?.payouts ?? []).map((p) => p.status))], verdict: res.ok ? `${res.json?.payouts?.length ?? 0} payout(s)` : 'REJECTED', notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('E1 refund of an UNPAID charge', 'What does Tap say when a refund targets a non-captured charge? (undocumented error codes)', async () => {
    const r = await provider.refundPayment({ gatewayPaymentId: created.bId, paymentId: created.b.paymentId, tenantId: created.b.tenantId, refundId: randomUUID(), amount: 1, currency: 'SAR', reason: 'sandbox probe' });
    return { verdict: `status=${r.status} success=${r.success}`, code: r.failureCode, notes: [`refundId=${r.gatewayRefundId ?? '-'}`] };
  });

  await probe('E2 unknown refund id', 'GET /v2/refunds/{unknown}: shape + our verifyRefund result', async () => {
    const res = await client.getRefund('re_TS00000000000000000000');
    const v = await provider.verifyRefund('re_TS00000000000000000000');
    return { ...resp(res), verdict: `verifyRefund → ${v.status}`, mappedStatuses: { REFUNDED: mapRefundStatus('REFUNDED'), PENDING: mapRefundStatus('PENDING'), DECLINED: mapRefundStatus('DECLINED') } };
  });

  await probe('F1 token from a fake saved card', 'Error shape for POST /v2/tokens with unknown card (MIT path)', async () => {
    const res = await client.createTokenFromSavedCard({ saved_card: { card_id: 'card_TS000000000000', customer_id: 'cus_TS000000000000' }, client_ip: '127.0.0.1' });
    return { ...resp(res), verdict: res.ok ? 'UNEXPECTED success' : `rejected (${res.errorCode ?? res.status})`, notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('G1 Lead with an EMPTY body', 'What does /v3/lead require, and is the platform/segment key accepted? (nothing is created: empty body)', async () => {
    const res = await client.createLead({});
    return { ...resp(res), errors: res.json?.errors, verdict: res.ok ? 'UNEXPECTED success' : `rejected (${res.errorCode ?? res.status})`, notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('G2 Connect with a FAKE lead id', 'Does /v3/connect answer, and with what? (nothing is created: fake lead)', async () => {
    const res = await client.createConnect({ scope: 'merchant', lead: { id: 'lead_TS000000000000' }, redirect: { url: 'https://example.com/app/payments?onboarding=return' } });
    return { ...resp(res), errors: res.json?.errors, verdict: res.ok ? 'UNEXPECTED success' : `rejected (${res.errorCode ?? res.status})`, notes: res.ok ? undefined : [res.errorDescription] };
  });

  await probe('H1 platform charge with a FAKE platform id', 'What does a charge on behalf of a merchant say when the platform is not activated? (rejected = nothing created)', async () => {
    process.env.TAP_PLATFORM_ID = 'commerce_platform_TS000000000000';
    try {
      const { res } = await rawCreate(baseRequest({ settlementMerchantId: 'merchant_TS000000000000', payee: 'clinic' }));
      return { ...resp(res), errors: res.json?.errors, verdict: res.ok ? `UNEXPECTED accepted (${res.json?.id})` : `rejected (${res.errorCode ?? res.status})`, notes: res.ok ? undefined : [res.errorDescription] };
    } finally {
      delete process.env.TAP_PLATFORM_ID;
    }
  });

  await probe('H2 OUR provider refuses a mis-routed clinic charge', 'Live check of the routing guard: a clinic payment Tap puts on OUR account must be refused, with no payment page', async () => {
    process.env.TAP_PLATFORM_ID = 'commerce_platform_TS000000000000';
    try {
      const r = await provider.createPayment(baseRequest({ settlementMerchantId: 'merchant_TS000000000000', payee: 'clinic' }));
      return { verdict: `status=${r.status} code=${r.failureCode} redirectUrl=${r.redirectUrl ? 'LEAKED' : 'none'} gatewayPaymentId=${r.gatewayPaymentId ?? 'none'}` };
    } finally {
      delete process.env.TAP_PLATFORM_ID;
    }
  });

  // ── summary ──
  console.log('\n══ SUMMARY ══');
  for (const r of results) {
    console.log(`${r.label.padEnd(44)} ${r.exception ? 'EXCEPTION' : `http=${r.http ?? '-'}`} ${r.code ? 'code=' + r.code : ''} ${r.verdict ?? ''}`);
  }
  if (stateFile && created.b) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ at: Date.now(), paymentId: created.b.paymentId, chargeId: created.bId }));
  }
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), env: config.tapEnv, results: results.map((r) => JSON.parse(JSON.stringify(r, (k, v) => safeValue(v)))) }, null, 2));
    console.log(`\nresults → ${outFile}`);
  }
})().catch((e) => {
  console.error('probe crashed:', e && e.message);
  process.exit(1);
});

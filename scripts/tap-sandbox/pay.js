#!/usr/bin/env node
/**
 * Tap SANDBOX assisted payment (Phase 7) — the part a script cannot do alone.
 *
 * It creates ONE hosted charge through OUR provider, prints the payment page, and waits
 * while a HUMAN pays with one of Tap's published test cards (a script must not type card
 * numbers into a third-party page). It then checks, against the real API, everything that
 * only exists once a charge is CAPTURED: our status mapping and captured amount, the
 * return URL Tap sends the payer to, the report row (fee / net), and — through OUR
 * provider — a partial refund, an idempotent repeat, the remaining refund and an
 * over-refund.
 *
 *   node scripts/tap-sandbox/pay.js [--amount 1] [--webhook https://<tunnel>/hook]
 *        [--source src_all|src_card] [--return-url https://example.com/app/billing?checkout=return]
 *        [--out results.json] [--no-refund] [--no-report]
 *
 * Test cards (Tap docs, /reference/testing-cards) — expiry decides the outcome:
 *   Visa 3DS 4508750015741019 · MasterCard 3DS 5123450000000008 · mada 3DS 4464040000000007
 *   expiry 01/39 → approved · 05/22 → declined · 08/28 → times out   (any CVV)
 *
 * SAFETY: sandbox only (sk_test_ + TAP_ENV=sandbox enforced); the key is never printed;
 * customer data is fake. `--rehearse <apiBase>` points the script at a LOCAL fake with a
 * fake key — it is how the script itself is tested, and sends nothing to Tap.
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, '.env') });

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && !String(process.argv[i + 1]).startsWith('--') ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(name);

process.env.TAP_ENV = 'sandbox';
const rehearse = arg('--rehearse');
if (rehearse) {
  process.env.TAP_TEST_SECRET_KEY = process.env.FAKE_TAP_SECRET || 'sk_test_BrowserVerifyNotARealSecret000';
  process.env.TAP_API_BASE = rehearse;
  process.env.TAP_MERCHANT_ID = process.env.TAP_MERCHANT_ID || 'rehearsal-merchant';
} else {
  delete process.env.TAP_API_BASE;
}
if (!(process.env.TAP_TEST_SECRET_KEY || '').startsWith('sk_test_')) {
  console.error('Refusing to run: TAP_TEST_SECRET_KEY is missing or is not an sk_test_ key.');
  process.exit(2);
}
for (const k of ['TAP_PLATFORM_ID', 'TAP_CHARGE_EXPIRY_MINUTES', 'TAP_WEBHOOK_URL']) delete process.env[k];
if (arg('--webhook')) process.env.TAP_WEBHOOK_URL = arg('--webhook');

const dist = (p) => require(path.join(root, 'dist', 'src', 'modules', 'payments', p));
const { PaymentsConfig } = dist('payments.config');
const { TapApiClient } = dist('providers/tap/tap-api.client');
const { TapGatewayProvider } = dist('providers/tap/tap-gateway.provider');
const { mapChargeStatus, safeFailureReason } = dist('providers/tap/tap-status.mapper');
const { parseChargeReport } = dist('providers/tap/tap-report.parser');

const config = new PaymentsConfig({ get: (k) => process.env[k] });
const client = new TapApiClient(config);
const provider = new TapGatewayProvider(config, client);

const amount = Number(arg('--amount', '1'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (q) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("close", () => !answered && resolve("")); // closed stdin (CI, rehearsal) = skip
    rl.question(q, (a) => {
      answered = true;
      rl.close();
      resolve(a);
    });
  });
const evidence = { at: new Date().toISOString(), rehearsal: !!rehearse, steps: [] };
const step = (name, data) => {
  evidence.steps.push({ name, ...data });
  console.log(`\n■ ${name}`);
  for (const [k, v] of Object.entries(data)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
};
const cents = (n) => Math.round(Number(n) * 100);

(async () => {
  const returnUrl = arg('--return-url', 'https://example.com/app/billing?checkout=return');
  const request = {
    paymentId: randomUUID(),
    tenantId: randomUUID(),
    amount,
    currency: 'SAR',
    description: 'ZiyaraTech sandbox assisted payment',
    returnUrl,
    payee: 'platform',
    customer: { firstName: 'Probe', email: 'probe@example.com', phone: { countryCode: '966', number: '512345678' } },
  };
  const body = provider.chargeBody(request);
  if (arg('--source')) body.source = { id: arg('--source') };
  const created = await client.createCharge(body);
  if (!created.ok || !created.json?.id) {
    step('create charge', { FAILED: true, http: created.status, code: created.errorCode, description: created.errorDescription });
    process.exit(1);
  }
  const chargeId = created.json.id;
  step('create charge', {
    chargeId,
    status: created.json.status,
    mapped: mapChargeStatus(created.json.status),
    webhookRegistered: !!created.json.post?.url,
    redirectEchoed: created.json.redirect?.url,
  });

  console.log(`\n══ PAY NOW (human step) ══\n${created.json.transaction.url}\n` +
    `Open it in a browser, pay with a Tap TEST card (see the header of this script), then come back.\n` +
    `Waiting up to 10 minutes for a terminal status…`);

  let last;
  let final;
  for (let i = 0; i < 200; i += 1) {
    const v = await provider.verifyPayment(chargeId);
    const shown = `${v.status}${v.failureCode ? ' (' + v.failureCode + ')' : ''}`;
    if (shown !== last) console.log(`  ${new Date().toISOString().slice(11, 19)} Tap → ${shown}`);
    last = shown;
    if (v.status === 'paid' || v.status === 'failed') {
      final = v;
      break;
    }
    await sleep(3000);
  }
  if (!final) {
    step('wait for payment', { RESULT: 'no terminal status within 10 minutes', last });
    process.exit(1);
  }

  const raw = (await client.getCharge(chargeId)).json;
  step('terminal charge', {
    tapStatus: raw.status,
    mapped: final.status,
    capturedCents: final.capturedMinorUnits,
    expectedCents: cents(amount),
    currency: final.capturedCurrency,
    responseCode: raw.response?.code,
    safeReason: final.status === 'failed' ? safeFailureReason(raw.response?.code, raw.status) : undefined,
    method: raw.source?.payment_method ?? raw.source?.type,
    threeDS: raw.threeDSecure,
    cardFields: raw.card ? Object.keys(raw.card) : undefined,
    receiptKeys: raw.receipt ? Object.keys(raw.receipt) : undefined,
    topLevelKeys: Object.keys(raw),
  });

  const pasted = (await ask('\nPaste the URL your browser ended up on after paying (Enter to skip): ')).trim();
  if (pasted) {
    try {
      const u = new URL(pasted);
      step('return URL', {
        host: u.host,
        path: u.pathname,
        params: [...u.searchParams.keys()],
        tap_id: u.searchParams.get('tap_id') === chargeId ? 'matches the charge' : u.searchParams.get('tap_id') ?? 'ABSENT',
        keptOurQuery: u.searchParams.get('checkout') === 'return' ? 'yes (our ?checkout=return survived)' : 'NO — our query parameter was lost',
        rawQueryHasDoubleQuestionMark: pasted.split('?').length > 2,
      });
    } catch {
      step('return URL', { unparseable: true });
    }
  }

  if (final.status === 'paid' && !flag('--no-refund')) {
    const money = (n) => Number(n.toFixed(2));
    const part = money(amount / 4);
    const rest = money(amount - part);
    const refundCall = (refundId, a) => provider.refundPayment({ gatewayPaymentId: chargeId, paymentId: request.paymentId, tenantId: request.tenantId, refundId, amount: a, currency: 'SAR', reason: 'requested_by_customer' });
    const settle = async (refundId, first) => {
      let v = first;
      for (let i = 0; i < 20 && v.status === 'pending' && v.gatewayRefundId; i += 1) {
        await sleep(3000);
        v = await provider.verifyRefund(v.gatewayRefundId);
      }
      return v;
    };

    const r1id = randomUUID();
    const r1 = await refundCall(r1id, part);
    const r1s = r1.gatewayRefundId ? await settle(r1id, r1) : r1;
    step('partial refund', { sent: part, created: r1.status, id: r1.gatewayRefundId, settled: r1s.status, code: r1.failureCode, echoedAmountCents: r1s.amountMinorUnits, echoedChargeId: r1s.gatewayPaymentId === chargeId ? 'matches' : r1s.gatewayPaymentId });

    const rep = await refundCall(r1id, part);
    step('repeat of the SAME refund id (idempotency)', { sameRefundReturned: rep.gatewayRefundId === r1.gatewayRefundId, id: rep.gatewayRefundId, status: rep.status });

    const over = await refundCall(randomUUID(), money(rest + 1));
    step('over-refund (more than remains)', { status: over.status, code: over.failureCode, success: over.success });

    const r2id = randomUUID();
    const r2 = await refundCall(r2id, rest);
    const r2s = r2.gatewayRefundId ? await settle(r2id, r2) : r2;
    step('remaining refund', { sent: rest, created: r2.status, id: r2.gatewayRefundId, settled: r2s.status, code: r2.failureCode });

    const after = (await client.getCharge(chargeId)).json;
    step('charge after refunds', { tapStatus: after.status, mapped: mapChargeStatus(after.status), keys: Object.keys(after).filter((k) => /refund/i.test(k)) });
  }

  // Report rows (may lag): fee / net / payout for the captured charge.
  if (!flag("--no-report")) console.log('\n… checking the charges report (Tap may take minutes to list a new charge; up to 3 tries)');
  for (let i = 0; i < (flag("--no-report") ? 0 : 3); i += 1) {
    const now = Date.now();
    const dl = await client.downloadCharges({ period: { date: { from: String(now - 24 * 3600_000), to: String(now) }, type: 'CHARGE' }, merchants: [config.tapMerchantId], limit: 200, starting_after: '' });
    const row = dl.ok ? parseChargeReport(dl.json).rows.find((r) => r.chargeId === chargeId) : undefined;
    if (row) {
      step('report row', { status: row.status, amount: row.amount, fee: row.fee, feeVat: row.feeVat, netAmount: row.netAmount, chargeDate: row.chargeDate, payoutId: row.payoutId, settlementDate: row.settlementDate, paymentMethod: row.paymentMethod });
      break;
    }
    if (i < 2) await sleep(60_000);
    else step('report row', { RESULT: 'charge not in the report yet (Tap index lag) — re-run the probe later' });
  }

  const out = arg('--out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(`\nevidence → ${out}`);
  }
})().catch((e) => {
  console.error('pay.js crashed:', e && e.message);
  process.exit(1);
});

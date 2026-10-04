#!/usr/bin/env node
/**
 * Tap SANDBOX webhook capture (Phase 7).
 *
 * A tiny, dependency-free receiver that records what Tap REALLY posts and checks the
 * `hashstring` header with OUR verifier — the one question no offline test can answer
 * (Tap documents the signed string but we have never seen a signed delivery).
 *
 *   node scripts/tap-sandbox/webhook-capture.js [--port 4545] [--out captures.jsonl]
 *   cloudflared tunnel --url http://localhost:4545        # or ngrok http 4545
 *   → use  https://<tunnel-host>/hook  as the --webhook URL of pay.js
 *
 * It answers 200 `{}` to everything (so Tap does not retry) and NEVER stores the full
 * body: only the fields the signature covers, our reference/metadata, and the card
 * last four. The key is read from .env through PaymentsConfig and is never printed.
 * Sandbox only (`sk_test_`).
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHmac } = require('node:crypto');

const root = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, '.env') });
process.env.TAP_ENV = 'sandbox';
const key = process.env.TAP_TEST_SECRET_KEY || '';
if (!key.startsWith('sk_test_')) {
  console.error('Refusing to run: TAP_TEST_SECRET_KEY is missing or is not an sk_test_ key.');
  process.exit(2);
}
const dist = (p) => require(path.join(root, 'dist', 'src', 'modules', 'payments', p));
const { PaymentsConfig } = dist('payments.config');
const { TapWebhookVerifier } = dist('webhooks/tap-webhook.verifier');
const { formatTapAmount } = dist('providers/tap/tap.types');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const port = Number(arg('--port', '4545'));
const outFile = arg('--out', path.join(__dirname, 'captures.jsonl'));
const verifier = new TapWebhookVerifier(new PaymentsConfig({ get: (k) => process.env[k] }));

const hmac = (s) => createHmac('sha256', key).update(s).digest('hex');

/** When our canonical string does NOT match, try plausible variants so the mismatch explains itself. */
function diagnose(p, header) {
  const ref = p.reference ?? {};
  const created = [p.transaction?.created, p.created, p.transaction?.date?.created].filter((v) => v !== undefined);
  const amounts = new Set();
  amounts.add(formatTapAmount(p.amount, p.currency));
  amounts.add(String(p.amount));
  amounts.add(Number(p.amount).toFixed(2));
  amounts.add(Number(p.amount).toFixed(3));
  const hits = [];
  for (const a of amounts) {
    for (const c of created) {
      for (const gw of [ref.gateway ?? '', '']) {
        for (const pay of [ref.payment ?? '', '']) {
          const s = `x_id${p.id}x_amount${a}x_currency${p.currency}x_gateway_reference${gw}x_payment_reference${pay}x_status${p.status}x_created${c}`;
          if (hmac(s) === String(header).toLowerCase()) hits.push({ amount: a, created: c, gateway: gw, payment: pay });
        }
      }
    }
  }
  return hits;
}

function redact(p) {
  return {
    object: p.object,
    id: p.id,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    created: p.created,
    transactionCreated: p.transaction?.created,
    reference: p.reference,
    metadata: p.metadata,
    merchant: p.merchant,
    platform: p.platform,
    chargeId: p.charge_id,
    responseCode: p.response?.code,
    cardLastFour: p.card?.last_four,
    saved: p.payment_agreement ? { agreement: !!p.payment_agreement.id } : undefined,
    topLevelKeys: Object.keys(p),
  };
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const header = req.headers['hashstring'];
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
      const record = {
        at: new Date().toISOString(),
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        headerNames: Object.keys(req.headers).sort(),
        hasHashstring: typeof header === 'string',
        bodyBytes: raw.length,
      };
      if (payload) {
        record.payload = redact(payload);
        record.canonicalBuilt = verifier.canonicalString(payload) !== null;
        record.verifiedByOurVerifier = verifier.verify(payload, header);
        if (!record.verifiedByOurVerifier && typeof header === 'string') record.diagnosis = diagnose(payload, header);
      }
      fs.appendFileSync(outFile, JSON.stringify(record) + '\n');
      const p = record.payload;
      console.log(
        `${record.at} ${req.method} ${req.url}  ${p ? `${p.object} ${p.id} ${p.status} ${p.amount} ${p.currency}` : '(not JSON)'}\n` +
          `   hashstring header: ${record.hasHashstring ? 'present' : 'ABSENT'}   our verifier: ${record.verifiedByOurVerifier ? 'MATCH ✔' : 'NO MATCH ✘'}` +
          (record.diagnosis ? `\n   variant that DOES match: ${JSON.stringify(record.diagnosis)}` : '') +
          (record.diagnosis && record.diagnosis.length === 0 ? '\n   no tried variant matches either' : ''),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  })
  .listen(port, () => console.log(`Tap webhook capture on http://localhost:${port}  → ${outFile}\n(expose it with a tunnel and pass the public URL to pay.js --webhook)`));

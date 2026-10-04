# Tap sandbox validation scripts (Phase 7)

Three small Node scripts that exercise **our compiled Tap code** (`dist/`) against the real
`https://api.tap.company` with the **test** secret key. Run `npm run build` first.

| Script | Needs a human? | Needs a public URL? | What it settles |
|---|---|---|---|
| `probe.js` | no | no | request shapes, error codes, idempotency, listing/report/payout shapes, the clinic-routing guard |
| `pay.js` | **yes** — pays one charge with a Tap test card | only to receive webhooks | CAPTURED mapping, return URL, report row (fee/net), refunds, idempotent refund, over-refund |
| `webhook-capture.js` | no | **yes** — a tunnel | what Tap really posts and whether our `hashstring` verification matches |

## Safety (enforced in code, not by convention)

- `TAP_ENV` is forced to `sandbox` and the key **must** start with `sk_test_`; otherwise the script exits before any request. The live keys in `.env` can never be used.
- The key is read through `PaymentsConfig` and never printed. Output is structural (status codes, Tap error codes, key names).
- Customer data is fake. Charges are small SAR amounts that nobody pays unless you do.
- `probe.js` sends the onboarding calls (Lead / Connect) **empty or with a fake id**, so no Tap lead or merchant is created.
- `pay.js --rehearse http://127.0.0.1:4455` swaps in a fake key and a local fake server; it sends nothing to Tap. That is how the script itself is tested.

## 1. Probe (no human, no tunnel)

```bash
node scripts/tap-sandbox/probe.js --out probe.json --state probe-state.json
```

Tap lists a **new** charge only after about **4–5 minutes** (measured 2026-10-04), so the
list/download lookups of a charge made by the same run answer `400 / 1249 "Charges not
found"`. Re-run later with the same `--state` file and those rows check the aged charge.

## 2. A real payment (a human types the test card)

```bash
node scripts/tap-sandbox/pay.js --out pay.json
```

Open the printed URL and pay with one of Tap's published **test** cards
(<https://developers.tap.company/reference/testing-cards>); the **expiry** picks the outcome:

| Card | Number |
|---|---|
| Visa 3DS | 4508750015741019 |
| MasterCard 3DS | 5123450000000008 |
| mada 3DS | 4464040000000007 |

Expiry `01/39` approves · `05/22` declines · `08/28` times out · any CVV. Run it three times
(approve / decline / timeout) and once with `--source src_card`. When asked, paste the URL your
browser landed on after paying — that is how the return URL (`tap_id`, our own `?checkout=return`)
is checked.

## 3. Webhooks (needs a public HTTPS URL)

Tap only posts to a public HTTPS address with a CA-issued certificate. Any tunnel works; it is
**your** choice and decision to expose a local port:

```bash
node scripts/tap-sandbox/webhook-capture.js --out captures.jsonl      # terminal 1 (port 4545)
cloudflared tunnel --url http://localhost:4545                        # terminal 2 (or: ngrok http 4545)
node scripts/tap-sandbox/pay.js --webhook https://<tunnel-host>/hook  # terminal 3
```

The capture tool prints, per delivery, whether `hashstring` matched our verifier, and if it did
not, which variant of the signed string does. It answers `200 {}` and stores only the signed
fields, our reference/metadata and the card last four — never the whole body. Stop the tunnel
afterwards.

## What these scripts cannot do

Merchant-initiated charges (**Save Card is not enabled on this account — probe `B8` returns
`1108`**), Platform charges for a clinic (no `TAP_PLATFORM_ID`), the clinic's Connect flow
(a real lead would be created), and `hashstring` semantics for the saved-card webhook.
Those wait on the Tap activations in `specs/017-tap-payments/phase-0-prerequisites.md`.

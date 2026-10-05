# 20K campaign lab — operator guide

Everything in this directory belongs to the post-feature 20,000-VU campaign. The older
suite (`../README.md`, `../start-api.ps1`, the September reports) is untouched and still
valid as the regression baseline; where it disagrees with this file about payments
(Moyasar → Tap) or the pool size, this file is current.

## Hard rules baked into the tooling

| Rule | Where it is enforced |
|---|---|
| Never touch production | `helpers/guard.js` (k6, at import + `setup()`), `run-campaign.mjs` (Node, before k6 starts): host must be loopback/private or allow-listed **and** confirmed; protected domains always refused; `/api/v1/metrics` must answer without a token (a production boot refuses that); lab DB name + `lt_lab_sentinel` row required |
| Never inherit real credentials | `make-lab-env.mjs` + `start-lab.mjs`: lab processes run with `cwd = lab/run/` (so `ConfigModule`'s hard-coded `.env` is the lab's) and an environment built from scratch |
| Never call a real provider | OpenAI/Resend/R2/Meta unset; Tap = **fake** `sk_test_` key against the loopback stub (`tap-stub.mjs`); WhatsApp accounts tokenless; no worker without that env |
| No secrets in output | secrets live in `lab/run/lab.json` (gitignored); k6 gets them through a temporary 0600 `--env-file`; summaries record only an allow-list of non-secret `LT_*` variables |
| Every number identifies its configuration | `reports/<tag>.manifest.json` (git commit, dist age, lab knobs, k6 image id, env, dataset counts, throttle mode) |
| Not measured is not claimed | scenarios/reports say `NOT MEASURED` / `NOT TESTED`; percentiles from merged histograms are labelled bucket-estimated |

## Quick start (Windows: Docker Desktop must be running)

```bash
cd Ziyarati-back
npm run build                                   # dist/ must not be older than src/ (the runner checks)
node tests/load/lab/make-lab-env.mjs            # lab config + secrets (first time)
node tests/load/lab/start-lab.mjs up            # pgvector Postgres + Redis, loopback, pinned images
node tests/load/lab/start-lab.mjs migrate       # all migrations on the lab DB
node tests/load/lab/start-lab.mjs seed-rbac     # roles/permissions
node tests/load/lab/seed-campaign.mjs           # dataset + lab sentinel   (see "Data")
node tests/load/lab/start-lab.mjs stub          # Tap stub
node tests/load/lab/start-lab.mjs api --workers 1 --pool 15
node tests/load/lab/start-lab.mjs worker
node tests/load/lab/mint-sessions.mjs           # sessions.json + packs (needs the API up)
node tests/load/lab/lint-scenarios.mjs          # static check of the k6 suite (no k6 needed)
node tests/load/lab/run-campaign.mjs smoke-campaign
```

`start-lab.mjs all` does the up → worker steps in one go. `status` shows what is running.

## Scenarios (`../scenarios/`)

| Script | Purpose | Key knobs |
|---|---|---|
| `smoke-campaign` | every new flow once, must be clean | `VUS`, `DURATION` |
| `calibrate` | generator ceiling vs `/api/v1/health` (app out of the loop) | `LT_CAL_LEVELS` |
| `business-mix` | persona mix at a sustainable size | `LT_VUS`, `LT_RAMP`, `LT_HOLD`, `LT_THINK_MS`, `LT_PERSONA_MIX`, `LT_HOT_SHARE` |
| `appointment-stress` | throughput / lifecycle / same-slot / same-doctor / hot-branch / multi-tenant | `LT_APPT_MODES`, `LT_RATE`, `LT_CONTEND_VUS` |
| `auth-herd` | herd / sustained / lifecycle / bad / lockout | `LT_HERD_VUS`, `LT_LOGIN_RATE` |
| `dashboard-reporting` | opens / refresh / cold / stampede / reports / platform | `LT_DASH_PARTS`, `LT_VUS` |
| `crm-search` | selective vs broad vs deep vs activity | `LT_CRM_PARTS`, `LT_HOT_SHARE` |
| `queue-workload` | board polling + reception cycles + xlsx import (needs the worker) | `LT_BOARD_VUS`, `LT_CYCLE_RATE` |
| `public-api` | discovery / funnel / marketplace / guest / partner / bad keys / rate limit | `LT_PUBLIC_PARTS`, `LT_MKT_RATE`, … |
| `whatsapp-webhook` | signed status events (+ messages only if `LT_WA_MESSAGES=true`) | `LT_WA_RATE` |
| `payment-webhook` | pay link / checkout race / return / Tap webhook (+dup) / billing / refund | `LT_PAY_PARTS`, rates |
| `ai-workload` | REST + Socket.IO turns with the provider stubbed | `LT_AI_PARTS` |
| `stress-20k` | the ladder, persona-driven + open-model probe | `LT_LEVELS`, `LT_RAMP`, `LT_HOLD`, `LT_THINK_MS` |
| `soak-20k` | high sustainable load for hours, windowed | `LT_SOAK_VUS`, `LT_SOAK_DURATION` |
| `recovery` | pre / surge / recovery phases + probe | `LT_PRE_VUS`, `LT_SURGE_VUS` |

Legacy scenarios (`smoke`, `baseline`, `mixed-workload`, `appointments-write` incl. the
30-VU contention, `vu-ladder`, …) are kept as regression scenarios and now also pass through
the target guard.

## Running at 20K — what a single host can and cannot do

* Each VU holds its own keep-alive connection. The Windows dynamic port range is 16,384 ports
  per source IP/destination, so one host cannot hold 20,000 sockets to one API address.
* `run-campaign.mjs --segments N` splits the VUs over N k6 containers (execution segments);
  `--segment i/N` runs one segment on THIS machine so several machines can share a run
  (same `--tag`, results merged afterwards). Run `calibrate` first to learn the real per-process ceiling.
* Percentiles are merged from latency-bucket counters (`helpers/buckets.js`); counters are exact.

## Throttling

Capacity stages run with `NODE_ENV=test` (global limit 300 → 1,000,000 per 60 s per handler/IP;
`trust proxy` is unset, so every VU shares one IP). That is the same method as September and is
printed as `throttle: lifted via NODE_ENV=test` in every manifest. A separate run keeps limits
**on** (`LT_ALLOW_429=true`, lab started without `NODE_ENV=test` is NOT supported — instead use
`chaos.mjs throttle-hit` for the production-limit behaviour) and reports 429 as measured behaviour.
Login lockout (5 failures per email / 900 s) is **never** relaxed.

## Not covered here (explicit)

R2/object-storage avatar path (NOT TESTED: no fake store), SES consumer (NOT TESTED), birthday
workflow sends (NOT TESTED: would need a workflow, which is deliberately absent), real OpenAI/Meta/Tap
latency (NOT MEASURED by design), production-sized Postgres/Redis (NOT MEASURED).

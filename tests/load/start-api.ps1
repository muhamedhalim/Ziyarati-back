# Starts the API configured for a load test, against the ISOLATED perf stack.
#
# Every value below is deliberate:
#
#  NODE_ENV=test            Lifts the global throttler from 300 req/60s to 1e6.
#                           Verified by grep: under this repo NODE_ENV=test
#                           changes ONLY rate limits — no auth, DB, cache or
#                           business-logic branch reads it. Without this you
#                           measure the throttler, not the application, because
#                           it is keyed on (handler, req.ip) and `trust proxy`
#                           is unset so per-VU IPs cannot spread the bucket.
#                           NOTE it does NOT relax the login lockout (5 failed
#                           attempts per email per 900s) — never load-test login
#                           with a wrong password.
#
#  TYPEORM_LOGGING=false    The tracked .env sets this TRUE. Per-statement
#  PLATFORM_API_LOG_ENABLED=false   console logging plus one synchronous-ish
#                           api_logs INSERT per request are both pure test
#                           overhead that compete with the workload for the same
#                           10-connection pool. Leaving them on understates
#                           capacity substantially.
#
#  OPENAI_API_KEY / RESEND_API_KEY / EMAIL_ENABLED / PAYMENT_PROVIDER
#                           The tracked .env carries LIVE credentials. Blanking
#                           them forces every provider factory down its
#                           Noop/stub branch (verified in the provider
#                           factories) so no paid API call and no real email can
#                           occur even by accident.
#
#  QUEUE_ENV_PREFIX         Namespaces every BullMQ key, so jobs this run
#                           enqueues can never be picked up by a real worker.
#
# THE REAL SAFETY GUARANTEE IS STRUCTURAL, NOT CONFIGURED: this script starts
# ONLY the API. The API is a queue PRODUCER; every external send (WhatsApp,
# email, webhooks, workflows) happens in the separate worker process. With no
# worker running, jobs accumulate in Redis and nothing leaves the machine.
# WhatsApp in particular CANNOT be disabled by env — MetaWhatsappProvider is the
# sole registered provider and its supports() is hardcoded true — so "no worker"
# plus "no whatsapp_accounts rows" is the guarantee. Do not start the worker.

#  -Workers N / -PoolMax N   Explicit knobs for the massive-scale phase's
#                           API_CLUSTER_WORKERS and pool-sensitivity
#                           experiments. Both default to "leave unset", so a
#                           plain invocation is byte-identical to before: the
#                           process count and pool size stay whatever .env and
#                           the code defaults say. They are experiment
#                           parameters, NOT recommended values — the connection
#                           budget (Workers x PoolMax, plus the worker process
#                           and any other consumer, against Postgres's own
#                           max_connections) has to be recalculated for every
#                           combination before it is used anywhere real.
param(
  [int]$Workers = 0,
  [int]$PoolMax = 0
)

$ErrorActionPreference = 'Stop'

$env:DATABASE_URL   = 'postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf'
$env:REDIS_URL      = 'redis://127.0.0.1:6380'
$env:PORT           = '3001'
$env:NODE_ENV       = 'test'

if ($Workers -gt 0) { $env:API_CLUSTER_WORKERS = "$Workers" }
else { Remove-Item Env:\API_CLUSTER_WORKERS -ErrorAction SilentlyContinue }
if ($PoolMax -gt 0) { $env:API_DB_POOL_MAX = "$PoolMax" }
else { Remove-Item Env:\API_DB_POOL_MAX -ErrorAction SilentlyContinue }

$env:TYPEORM_SYNCHRONIZE = 'false'
$env:TYPEORM_LOGGING     = 'false'
$env:SEED_ON_STARTUP     = 'false'
$env:PLATFORM_API_LOG_ENABLED = 'false'

# External kill-switches (defence in depth; the worker being down is the real one)
$env:OPENAI_API_KEY     = ''
$env:RESEND_API_KEY     = ''
$env:EMAIL_ENABLED      = 'false'
$env:PAYMENT_PROVIDER   = 'noop'
$env:QUEUE_ENV_PREFIX   = 'loadtest'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$log  = Join-Path $PSScriptRoot 'reports\api.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

$cfg = "workers=$(if ($env:API_CLUSTER_WORKERS) { $env:API_CLUSTER_WORKERS } else { '1 (unset)' })" +
       " poolMax=$(if ($env:API_DB_POOL_MAX) { $env:API_DB_POOL_MAX } else { 'from .env/default' })"
Write-Output "Starting API (load-test config) from $root  [$cfg]"
Start-Process -FilePath 'node' -ArgumentList 'dist/src/main' `
  -WorkingDirectory $root `
  -RedirectStandardOutput $log `
  -RedirectStandardError "$log.err" `
  -NoNewWindow

Write-Output "Waiting for readiness..."
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/v1/system/health/readiness' -TimeoutSec 3
    if ($r.status -eq 'ok') { Write-Output "API ready: db=$($r.database.status) redis=$($r.redis.status)"; exit 0 }
  } catch { }
}
Write-Output "API did not become ready - see $log.err"
exit 1

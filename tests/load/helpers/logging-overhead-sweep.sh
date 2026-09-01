#!/usr/bin/env bash
# Phase 2.1 — the same isolation as logging-overhead.sh, but at rates near
# saturation, where the cost actually binds. At 8 it/s the system has enough
# headroom that the overhead is invisible; the reported "~38% throughput" only
# manifests once CPU is the constraint.
set -u
cd /d/projects/Ziyarati-full/Ziyarati-back

RATES="${RATES:-60,80,100}"
BASE_ENV=(
  DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf'
  REDIS_URL='redis://127.0.0.1:6380' PORT=3002 NODE_ENV=test
  TYPEORM_SYNCHRONIZE=false SEED_ON_STARTUP=false
  OPENAI_API_KEY='' RESEND_API_KEY='' EMAIL_ENABLED=false
  PAYMENT_PROVIDER=noop MOYASAR_SECRET_KEY='' QUEUE_ENV_PREFIX=loadtest
)
psql_q() { MSYS_NO_PATHCONV=1 docker exec ziyarati-perfaudit-postgres \
  psql -U postgres -d ziyarati_perf -t -A -c "$1" 2>/dev/null | tr -d '\r'; }
metric() { curl -s http://127.0.0.1:3002/api/v1/metrics 2>/dev/null \
  | awk -v k="$1" '$0 ~ "^"k {s+=$2} END {printf "%.3f", s+0}'; }

for spec in "$@"; do
  label="${spec%%:*}"; extra="${spec#*:}"
  env "${BASE_ENV[@]}" $extra node dist/src/main > "/tmp/sw-$label.log" 2>&1 &
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/v1/system/health/readiness 2>/dev/null)
    [ "$code" = "200" ] && break; sleep 1
  done
  [ "$code" != "200" ] && { echo "$label: FAILED TO START"; continue; }

  rows0=$(psql_q "SELECT count(*) FROM api_logs"); q0=$(metric db_queries_total)
  c0=$(metric process_cpu_seconds_total); t0=$(date +%s)

  TEST_PASSWORD="$TEST_PASSWORD" BASE_URL=http://host.docker.internal:3002 \
    RATES="$RATES" STEP_DURATION=40s MSYS_NO_PATHCONV=1 \
    docker compose -f tests/load/docker-compose.yml run --rm k6 \
    run /scripts/scenarios/progressive-sweep.js > /dev/null 2>&1

  t1=$(date +%s); q1=$(metric db_queries_total); c1=$(metric process_cpu_seconds_total)
  rows1=$(psql_q "SELECT count(*) FROM api_logs")
  cp tests/load/reports/progressive-sweep.json "tests/load/reports/logsweep-$label.json"

  node -e "
    const s=require('./tests/load/reports/logsweep-$label.json');
    const dt=$t1-$t0, dq=$q1-$q0, dc=$c1-$c0, dr=$rows1-$rows0;
    console.log('--- $label ---  cpu='+(dc/dt*100).toFixed(1)+'%  dbStatements='+dq+'  apiLogRows='+dr);
    for (const r of s.steps)
      console.log('   rate='+String(r.rate_iterations_per_s).padStart(3),
        'req/s='+(r.requests/40).toFixed(0).padStart(4),
        'p50='+r.p50_ms.toFixed(0).padStart(5),
        'p95='+r.p95_ms.toFixed(0).padStart(6),
        'p99='+r.p99_ms.toFixed(0).padStart(6),
        'err='+(r.error_rate*100).toFixed(2)+'%');
  "
  P=$(powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue).OwningProcess" 2>/dev/null | tr -d '\r')
  [ -n "$P" ] && powershell -NoProfile -Command "Stop-Process -Id $P -Force" >/dev/null 2>&1
  sleep 3
done

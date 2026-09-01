#!/usr/bin/env bash
# Phase 2.1 — isolates the cost of each logging flag.
#
# Runs the SAME baseline scenario against a throwaway API on :3002, once per
# configuration, capturing k6 latency plus the server's own counters
# (db_queries_total, process CPU) and the actual api_logs rows written.
#
# Usage: TEST_PASSWORD=... bash logging-overhead.sh "<label>:<ENV=V ...>" ...
set -u
cd /d/projects/Ziyarati-full/Ziyarati-back

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
  env "${BASE_ENV[@]}" $extra node dist/src/main > "/tmp/api-$label.log" 2>&1 &
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/v1/system/health/readiness 2>/dev/null)
    [ "$code" = "200" ] && break; sleep 1
  done
  [ "$code" != "200" ] && { echo "$label: FAILED TO START"; continue; }

  rows0=$(psql_q "SELECT count(*) FROM api_logs")
  q0=$(metric db_queries_total); c0=$(metric process_cpu_seconds_total)
  t0=$(date +%s)

  TEST_PASSWORD="$TEST_PASSWORD" BASE_URL=http://host.docker.internal:3002 \
    RATE=8 DURATION=90s MSYS_NO_PATHCONV=1 \
    docker compose -f tests/load/docker-compose.yml run --rm k6 \
    run /scripts/scenarios/baseline.js > /dev/null 2>&1

  t1=$(date +%s)
  q1=$(metric db_queries_total); c1=$(metric process_cpu_seconds_total)
  rows1=$(psql_q "SELECT count(*) FROM api_logs")
  cp tests/load/reports/baseline.json "tests/load/reports/logging-$label.json"

  node -e "
    const r=require('./tests/load/reports/logging-$label.json');
    const dt=$t1-$t0, dq=$q1-$q0, dc=$c1-$c0, dr=$rows1-$rows0;
    console.log('$label'.padEnd(16),
      'rps='+(r.http_reqs/dt).toFixed(1).padStart(6),
      'p50='+r.p50_ms.toFixed(1).padStart(6),
      'p95='+r.p95_ms.toFixed(1).padStart(6),
      'p99='+r.p99_ms.toFixed(1).padStart(7),
      'reqs='+String(r.http_reqs).padStart(5),
      'dbq='+String(dq).padStart(6),
      'api_log_rows='+String(dr).padStart(5),
      'cpu='+(dc/dt*100).toFixed(1).padStart(5)+'%',
      'err='+(r.error_rate*100).toFixed(2)+'%');
  "
  P=$(powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue).OwningProcess" 2>/dev/null | tr -d '\r')
  [ -n "$P" ] && powershell -NoProfile -Command "Stop-Process -Id $P -Force" >/dev/null 2>&1
  sleep 3
done

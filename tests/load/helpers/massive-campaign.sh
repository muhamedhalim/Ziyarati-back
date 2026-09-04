#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# The massive-scale campaign, after the VU ladders.
#
# Runs the arrival-rate sweeps that produce the actual capacity number, the
# API_CLUSTER_WORKERS comparison, the pool-sensitivity control, the same-tenant
# hotspot, and the no-think-time control — in one sequence, with a database
# cleanup between every scenario so no run reads a dataset a previous run wrote.
#
# The API is restarted between configurations and NOTHING ELSE CHANGES: same
# rates, same duration, same data, same code, same machine. That is what makes
# the worker comparison a comparison.
#
# Usage:  TEST_PASSWORD='...' tests/load/helpers/massive-campaign.sh [stage]
#         stage: all (default) | sweeps | hotspot | controls
# ---------------------------------------------------------------------------
set -u
STAGE="${1:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="$ROOT/tests/load/helpers/run-scenario.sh"
PG=ziyarati-perfaudit-postgres
DB=ziyarati_perf

# Identical for every sweep in the comparison. 8 steps x 45s + gaps ~= 6.7 min.
SWEEP_RATES=20,30,40,50,60,80,100,120
SWEEP_STEP=45s

cleanup() {
  MSYS_NO_PATHCONV=1 docker exec "$PG" psql -U postgres -d "$DB" -f /tmp/cleanup.sql >/dev/null 2>&1
}

restart_api() {  # $1 = workers (0 = unset), $2 = poolMax (0 = unset)
  powershell -NoProfile -ExecutionPolicy Bypass -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'dist[\\\\/]src[\\\\/]main' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" \
    >/dev/null 2>&1
  sleep 3
  powershell -NoProfile -ExecutionPolicy Bypass -File "$ROOT/tests/load/start-api.ps1" \
    -Workers "$1" -PoolMax "$2"
}

sweep() {  # $1 = tag, $2 = workers, $3 = poolMax
  echo; echo "########## $1  (workers=$2 poolMax=$3) ##########"
  cleanup
  restart_api "$2" "$3" || { echo "API failed to start for $1"; return 1; }
  MSYS_NO_PATHCONV=1 docker exec "$PG" psql -U postgres -d "$DB" -t -A \
    -c "SELECT count(*) AS pg_connections_at_idle FROM pg_stat_activity WHERE datname='$DB';"
  bash "$RUN" "$1" progressive-sweep.js \
    TEST_TENANTS=50 MIX_PROFILE=prod-mix RATES=$SWEEP_RATES STEP_DURATION=$SWEEP_STEP \
    2>&1 | grep -vE "^running|level=warning|^\s+r[0-9]+ "
}

if [ "$STAGE" = all ] || [ "$STAGE" = sweeps ]; then
  sweep sweep-w1        1 0    # baseline: 1 process, pool from .env (10)
  sweep sweep-w2        2 0    # 2 processes x 10 = 20 connections
  sweep sweep-w4        4 0    # 4 processes x 10 = 40 connections
  sweep sweep-w1-pool30 1 30   # pool sensitivity control: 1 process, pool 30
fi

if [ "$STAGE" = all ] || [ "$STAGE" = hotspot ]; then
  echo; echo "########## same-tenant hotspot vs even spread ##########"
  restart_api 1 0
  # Same level, same duration, same everything — only the tenant distribution
  # differs, so any delta is attributable to the skew and nothing else.
  for skew in 0 0.8; do
    cleanup
    tag="hotspot-skew${skew/./}"
    bash "$RUN" "$tag" vu-ladder.js \
      TEST_TENANTS=50 MIX_PROFILE=prod-mix LEVELS=500 RAMP=20s HOLD=60s GAP=20s \
      THINK_MS=3000 TENANT_SKEW=$skew \
      2>&1 | grep -vE "^running|level=warning|^\s+(vu|rec)[0-9]+ "
  done
fi

if [ "$STAGE" = all ] || [ "$STAGE" = controls ]; then
  echo; echo "########## think-time control ##########"
  restart_api 1 0
  # Proves the claim the whole VU ladder rests on: without think time a VU is
  # not a user. Same 100 VUs, same everything, THINK_MS=0.
  cleanup
  bash "$RUN" control-nothink vu-ladder.js \
    TEST_TENANTS=50 MIX_PROFILE=prod-mix LEVELS=100 RAMP=20s HOLD=60s GAP=20s THINK_MS=0 \
    2>&1 | grep -vE "^running|level=warning|^\s+(vu|rec)[0-9]+ "
fi

cleanup
echo; echo "########## campaign stage '$STAGE' complete ##########"

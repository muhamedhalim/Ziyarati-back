#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One measured run = k6 + server-side monitor + a pg_stat_statements window.
#
# Exists because the three have to be started and stopped TOGETHER or the
# numbers do not line up: a monitor started late misses the ramp, and a
# pg_stat_statements snapshot that is not reset immediately before the run
# reports the previous run's statements as if they were this one's.
#
# Usage:
#   tests/load/helpers/run-scenario.sh <tag> <scenario.js> [extra env assignments...]
#
# Example:
#   TEST_PASSWORD=... tests/load/helpers/run-scenario.sh ladder-a vu-ladder.js \
#       MIX_PROFILE=prod-mix TEST_TENANTS=50
#
# Every artifact lands in tests/load/reports/massive/<tag>.*
# ---------------------------------------------------------------------------
set -u

TAG="${1:?usage: run-scenario.sh <tag> <scenario.js> [ENV=V ...]}"
SCENARIO="${2:?scenario file name under tests/load/scenarios/}"
shift 2

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$ROOT/tests/load/reports/massive"
PG=ziyarati-perfaudit-postgres
DB=ziyarati_perf
mkdir -p "$OUT"

# Extra KEY=VALUE pairs become environment for the compose run.
for kv in "$@"; do export "${kv?}"; done
export RUN_TAG="$TAG"

echo "=== [$TAG] $SCENARIO ==="

# 1. pg_stat_statements window starts empty, so the top-N table below is this
#    run's statements and nobody has to subtract a previous run by hand.
MSYS_NO_PATHCONV=1 docker exec "$PG" psql -U postgres -d "$DB" -t -A \
  -c "SELECT pg_stat_statements_reset();" >/dev/null 2>&1

# 2. Server-side monitor. Runs unbounded and is stopped with the k6 process, so
#    it covers exactly the run window including ramp-up and drain.
#    Stopped by a SENTINEL FILE, not a signal: `kill -TERM` from Git Bash does
#    not reach a Windows node process as a catchable SIGTERM, so the monitor's
#    handler never runs and every sample it collected is lost with the process.
STOPFILE="$OUT/$TAG.stop"
rm -f "$STOPFILE"
node "$ROOT/tests/load/helpers/monitor.js" \
  --out "$OUT/$TAG.monitor.json" --interval 2000 --redis --gen --locks \
  --stopfile "$STOPFILE" \
  > "$OUT/$TAG.monitor.log" 2>&1 &
MON=$!
sleep 2

# 3. k6, bracketed by an OS-level CPU snapshot of every API process.
#    With API_CLUSTER_WORKERS > 1 a Prometheus scrape reaches ONE worker, so
#    /metrics cannot give the deployment's total CPU — the process table can.
powershell -NoProfile -ExecutionPolicy Bypass -File "$ROOT/tests/load/helpers/api-cpu-snapshot.ps1" -Label before \
  > "$OUT/$TAG.cpu.txt" 2>&1

( cd "$ROOT" && MSYS_NO_PATHCONV=1 docker compose -f tests/load/docker-compose.yml \
    run --rm k6 run "/scripts/scenarios/$SCENARIO" ) 2>&1 | tee "$OUT/$TAG.k6.log"
K6_RC=${PIPESTATUS[0]}

powershell -NoProfile -ExecutionPolicy Bypass -File "$ROOT/tests/load/helpers/api-cpu-snapshot.ps1" -Label after \
  >> "$OUT/$TAG.cpu.txt" 2>&1

# 4. Stop the monitor and let it flush its summary.
touch "$STOPFILE"
wait "$MON" 2>/dev/null; rm -f "$STOPFILE"
sleep 1

# 5. Top statements for this window only. total_exec_time ranks what the
#    database actually spent the run doing; calls ranks what it was asked to do
#    most often — a slow statement called twice and a fast one called 40,000
#    times are different problems, so both orderings are captured.
MSYS_NO_PATHCONV=1 docker exec "$PG" psql -U postgres -d "$DB" -P pager=off -c "
  SELECT round(total_exec_time)::bigint AS total_ms, calls,
         round(mean_exec_time::numeric,2) AS mean_ms, rows,
         left(regexp_replace(query, '\s+', ' ', 'g'), 150) AS query
    FROM pg_stat_statements
   WHERE dbid = (SELECT oid FROM pg_database WHERE datname='$DB')
   ORDER BY total_exec_time DESC LIMIT 25;" > "$OUT/$TAG.pgstat-bytime.txt" 2>&1

MSYS_NO_PATHCONV=1 docker exec "$PG" psql -U postgres -d "$DB" -P pager=off -c "
  SELECT calls, round(total_exec_time)::bigint AS total_ms,
         round(mean_exec_time::numeric,2) AS mean_ms, rows,
         left(regexp_replace(query, '\s+', ' ', 'g'), 150) AS query
    FROM pg_stat_statements
   WHERE dbid = (SELECT oid FROM pg_database WHERE datname='$DB')
   ORDER BY calls DESC LIMIT 25;" > "$OUT/$TAG.pgstat-bycalls.txt" 2>&1

# 6. What the run left behind, before any cleanup runs.
MSYS_NO_PATHCONV=1 docker exec "$PG" psql -U postgres -d "$DB" -P pager=off \
  -f /tmp/integrity-check.sql > "$OUT/$TAG.integrity.txt" 2>&1

echo "=== [$TAG] artifacts in tests/load/reports/massive/$TAG.* (k6 rc=$K6_RC) ==="
exit "$K6_RC"

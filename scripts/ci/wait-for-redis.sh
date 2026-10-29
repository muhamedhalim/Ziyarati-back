#!/usr/bin/env bash
# Waits for the CI Redis container to answer PING on its PUBLISHED host port — the address the tests
# actually connect to — and fails with an actionable diagnosis if it does not.
#
#   scripts/ci/wait-for-redis.sh <container> <host-port> [timeout-seconds]
#   scripts/ci/wait-for-redis.sh zt-e2e-redis 63790 30
#
# Why not `docker exec <c> redis-cli ping` (what the workflows did): that proves Redis is up INSIDE the
# container, not that the published port works, so a bad port mapping passed readiness and then every
# spec failed later with ECONNREFUSED far from the cause. The old loop also reported the same bare
# "Redis did not become ready" whether the container had exited, never started, or was merely slow.
#
# Behaviour:
#   - bounded: gives up after <timeout-seconds> (default 30), never loops forever;
#   - fails FAST, naming the reason, when the container is missing or not running (no waiting out the
#     timeout for something that cannot recover);
#   - on failure prints the container state, exit code, OOM flag, port mapping, listeners on the port and
#     the last 50 log lines, so the cause is in the job log without re-running it;
#   - exits 0 only after a real `+PONG` from 127.0.0.1:<host-port>.
#
# Test seam: DOCKER_BIN (default `docker`, may be a command plus arguments) lets the spec in src/config
# drive every branch with a shim.
set -u

container="${1:-}"
port="${2:-}"
timeout_s="${3:-30}"
read -r -a DOCKER <<<"${DOCKER_BIN:-docker}"
host="${REDIS_CHECK_HOST:-127.0.0.1}"

if [ -z "$container" ] || [ -z "$port" ] || ! [[ "$port" =~ ^[0-9]+$ ]] || ! [[ "$timeout_s" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <container> <host-port> [timeout-seconds]" >&2
  exit 2
fi

# `+PONG` from a real RESP PING over TCP, itself bounded to 2 s so a blackholed port cannot hang the loop.
ping_host_port() {
  local reply
  reply="$(timeout 2 bash -c "exec 3<>/dev/tcp/${host}/${port} && printf 'PING\r\n' >&3 && head -n 1 <&3" 2>/dev/null | tr -d '\r')"
  [ "$reply" = "+PONG" ]
}

container_state() {
  local status
  if status="$("${DOCKER[@]}" inspect -f '{{.State.Status}}' "$container" 2>/dev/null)" && [ -n "${status//[[:space:]]/}" ]; then
    echo "${status//[[:space:]]/}"
  else
    echo "missing"
  fi
}

diagnostics() {
  echo "::group::Redis diagnostics (${container}, port ${port})"
  echo "--- docker ps -a (name=${container})"
  "${DOCKER[@]}" ps -a --filter "name=${container}" 2>&1 || true
  echo "--- state"
  "${DOCKER[@]}" inspect -f 'status={{.State.Status}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} error={{.State.Error}} startedAt={{.State.StartedAt}}' "$container" 2>&1 || true
  echo "--- published ports"
  "${DOCKER[@]}" port "$container" 2>&1 || true
  echo "--- listeners on :${port}"
  (ss -ltn "sport = :${port}" 2>/dev/null || netstat -ltn 2>/dev/null | grep ":${port} ") || echo "(none found)"
  echo "--- last 50 log lines"
  "${DOCKER[@]}" logs --tail 50 "$container" 2>&1 || true
  echo "::endgroup::"
}

deadline=$((SECONDS + timeout_s))
reason="no answer yet"
while :; do
  state="$(container_state)"
  if [ "$state" != "running" ]; then
    reason="container '${container}' is ${state}, not running"
    echo "::error::Redis is not available: ${reason}"
    diagnostics
    exit 1
  fi
  if ping_host_port; then
    echo "Redis ready on ${host}:${port} (container ${container}) after $((timeout_s - (deadline - SECONDS)))s"
    exit 0
  fi
  reason="container '${container}' is running but ${host}:${port} did not answer PING"
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::Redis did not become ready within ${timeout_s}s: ${reason}"
    diagnostics
    exit 1
  fi
  sleep 1
done

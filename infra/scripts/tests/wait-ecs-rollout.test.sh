#!/usr/bin/env bash
# Offline test for infra/scripts/wait-ecs-rollout.sh and its wiring in ecs-deploy.sh. A fake `aws`
# replays a scripted sequence of describe-services answers per service, so it needs no AWS account.
#   bash infra/scripts/tests/wait-ecs-rollout.test.sh
# CI: executed by .github/workflows/terraform.yml (static job) so the gate itself cannot rot.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../wait-ecs-rollout.sh"
DEPLOY="$HERE/../ecs-deploy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NEW="arn:aws:ecs:eu-central-1:111122223333:task-definition/zt-production-api:42"
OLD="arn:aws:ecs:eu-central-1:111122223333:task-definition/zt-production-api:41"
OTHER="arn:aws:ecs:eu-central-1:111122223333:task-definition/zt-production-api:43"
WNEW="arn:aws:ecs:eu-central-1:111122223333:task-definition/zt-production-worker:42"
WOLD="arn:aws:ecs:eu-central-1:111122223333:task-definition/zt-production-worker:41"

# Fake aws. Per service (api|worker):
#   $FAKE/<svc>.seq     blocks separated by a line "---"; poll N consumes block N, the last block repeats.
#                       A block is deployment rows (tab separated, like --output text), or the word
#                       ERR (AWS error, exit 254) or NONE (the "None" a missing service prints).
#   $FAKE/<svc>.events  the ECS service events returned by the events query
mkdir -p "$TMP/bin"
cat > "$TMP/bin/aws" <<'EOF'
#!/usr/bin/env bash
args="$*"
svc=worker; [[ "$args" == *"-api"* ]] && svc=api
if [[ "$args" == *"ecs describe-services"*"events"* ]]; then cat "$FAKE/$svc.events" 2>/dev/null; exit 0; fi
if [[ "$args" == *"ecs describe-services"*"deployments"* ]]; then
  n=$(( $(cat "$FAKE/$svc.count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE/$svc.count"
  block="$(awk -v n="$n" 'BEGIN{b=1} /^---$/{b++; next} {blk[b]=blk[b] $0 "\n"; last=b} END{ if (n>last) n=last; printf "%s", blk[n] }' "$FAKE/$svc.seq")"
  case "$block" in
    ERR*)  echo "An error occurred (ThrottlingException) when calling the DescribeServices operation" >&2; exit 254 ;;
    NONE*) echo "None"; exit 0 ;;
    *)     printf '%s' "$block"; exit 0 ;;
  esac
fi
echo "fake aws: unhandled: $args" >&2; exit 99
EOF
chmod +x "$TMP/bin/aws"

T=$'\t'
row() { # id status rollout taskdef desired running pending failed reason
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "${8:-0}" "${9:-None}"
}
seq_file() { printf '%s' "$2" > "$FAKE/$1.seq"; }

pass=0; failn=0
OUT=""; RC=0
run() { # name expect-exit expect-output-substring [env assignments via exported ROLLOUT_*]
  local name="$1" want="$2" needle="${3:-}"
  OUT="$(PATH="$TMP/bin:$PATH" FAKE="$FAKE" bash "$SCRIPT" zt-production "zt-production-api=$NEW" "zt-production-worker=$WNEW" 2>&1)"; RC=$?
  if [[ "$OUT" == *unhandled* ]]; then failn=$((failn+1)); echo "FAIL - $name: fake aws gap"; return; fi
  if [[ "$RC" == "$want" && ( -z "$needle" || "$OUT" == *"$needle"* ) ]]; then
    pass=$((pass+1)); echo "ok   - $name  [exit $RC]"
  else
    failn=$((failn+1)); echo "FAIL - $name (exit $RC, wanted $want${needle:+, output containing '$needle'})"; sed 's/^/       /' <<<"$OUT" | tail -n 25
  fi
}
reset() {
  FAKE="$TMP/fake"; rm -rf "$FAKE"; mkdir -p "$FAKE"; export FAKE
  export ROLLOUT_POLL_SECONDS=0 ROLLOUT_TIMEOUT_SECONDS=30 ROLLOUT_MAX_CONSECUTIVE_ERRORS=3 ROLLOUT_VISIBLE_GRACE_SECONDS=60
  seq_file api "$(row ecs-svc/1 PRIMARY COMPLETED "$NEW" 2 2 0)"
  seq_file worker "$(row ecs-svc/2 PRIMARY COMPLETED "$WNEW" 1 1 0)"
  : > "$FAKE/api.events"; : > "$FAKE/worker.events"
}

# ── outcomes ────────────────────────────────────────────────────────────────
reset; run "deployment already PRIMARY COMPLETED, alone, fully running" 0 "all 2 service(s) rolled out"

reset; seq_file api "$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 1 1)
---
$(row d1 PRIMARY COMPLETED "$NEW" 2 2 0)"
run "IN_PROGRESS on the first poll, COMPLETED on the next (the reported failure)" 0 "PRIMARY IN_PROGRESS"

reset; seq_file api "$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 2 0)
---
$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 2 0)
---
$(row d1 PRIMARY COMPLETED "$NEW" 2 2 0)"
run "single deployment, tasks all running, rollout still IN_PROGRESS for two polls" 0

reset; seq_file api "$(row d1 PRIMARY COMPLETED "$NEW" 2 2 0)
$(row d0 ACTIVE COMPLETED "$OLD" 2 2 0)
---
$(row d1 PRIMARY COMPLETED "$NEW" 2 2 0)"
run "COMPLETED but the old deployment is still draining: keeps waiting, then succeeds" 0 "2 deployment(s)"

reset; seq_file api "$(row d0 PRIMARY COMPLETED "$OLD" 2 2 0)
---
$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 0 2)
$(row d0 ACTIVE COMPLETED "$OLD" 2 2 0)
---
$(row d1 PRIMARY COMPLETED "$NEW" 2 2 0)"
run "new deployment not visible yet (old still PRIMARY), then appears" 0 "not visible yet"

# ── failures ────────────────────────────────────────────────────────────────
reset; seq_file api "$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 1 1)
---
$(row d1 PRIMARY FAILED "$NEW" 2 0 2 3 'ECS deployment circuit breaker: tasks failed to start')"
run "new deployment FAILED (circuit breaker)" 10 "is FAILED"

reset; seq_file api "$(row d2 PRIMARY IN_PROGRESS "$OLD" 2 2 0)
$(row d1 ACTIVE FAILED "$NEW" 2 0 0 3 'tasks failed to start')"
run "circuit breaker rolled back: old revision PRIMARY, new one FAILED" 10 "rolled back to"

reset; seq_file api "$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 1 1)
---
$(row d2 PRIMARY COMPLETED "$OLD" 2 2 0)"
printf '%s\t%s\n' 2026-10-21T10:00:00Z '(service zt-production-api) rolling back to deployment ecs-svc/0 (circuit breaker)' > "$FAKE/api.events"
run "rollback finished before the next poll: detected from ECS events" 10 "rolled back by ECS"

reset; seq_file api "$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 1 1)
---
$(row d9 PRIMARY IN_PROGRESS "$OTHER" 2 2 0)"
printf '%s\t%s\n' 2026-10-21T10:00:00Z '(service zt-production-api) has started 2 tasks' > "$FAKE/api.events"
run "another deployment superseded the monitored one" 11 "superseded"

reset; seq_file api "$(row d0 PRIMARY COMPLETED "$OLD" 2 2 0)"
export ROLLOUT_VISIBLE_GRACE_SECONDS=0
run "new deployment never became PRIMARY" 11 "not the"

reset; seq_file worker "$(row w1 PRIMARY FAILED "$WNEW" 1 0 1 2 'health check failed')"
run "worker fails while the API is fine" 10 "zt-production-worker"

# ── timeout and unhealthy tasks ─────────────────────────────────────────────
reset; seq_file api "$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 1 1)"
export ROLLOUT_TIMEOUT_SECONDS=2 ROLLOUT_POLL_SECONDS=1
run "rollout stays IN_PROGRESS past the deadline" 12 "timed out after 2s"

reset; seq_file api "$(row d1 PRIMARY IN_PROGRESS "$NEW" 2 1 1 4 'tasks not healthy')"
printf '%s\t%s\n' 2026-10-21T10:00:00Z '(service zt-production-api) (port 3000) is unhealthy in (target-group arn:x) due to (reason Health checks failed with these codes: [503])' > "$FAKE/api.events"
export ROLLOUT_TIMEOUT_SECONDS=2 ROLLOUT_POLL_SECONDS=1
run "new tasks fail ALB health checks: timeout report carries the events" 12 "unhealthy in (target-group"
[[ "$OUT" == *"failedTasks"* || "$OUT" == *"tasks not healthy"* ]] && { pass=$((pass+1)); echo "ok   - timeout report lists deployment state"; } || { failn=$((failn+1)); echo "FAIL - timeout report lacks deployment state"; }
[[ "$OUT" == *"migrations ran BEFORE"* ]] && { pass=$((pass+1)); echo "ok   - failure report states the database position"; } || { failn=$((failn+1)); echo "FAIL - failure report lacks the database note"; }

reset; seq_file api "$(row d1 PRIMARY COMPLETED "$NEW" 2 1 0)"
export ROLLOUT_TIMEOUT_SECONDS=2 ROLLOUT_POLL_SECONDS=1
run "COMPLETED but runningCount < desiredCount is not success" 12

# ── AWS failures ────────────────────────────────────────────────────────────
reset; seq_file api "ERR
---
$(row d1 PRIMARY COMPLETED "$NEW" 2 2 0)"
run "one transient AWS error is tolerated" 0

reset; seq_file api "ERR"
run "persistent AWS errors fail (never reported as success)" 13 "consecutive AWS errors"

reset; seq_file api "NONE"
run "incomplete answer ('None' for a missing service) fails" 13

reset; seq_file api "$(printf 'garbage\n')"
run "unparseable answer fails" 13

# ── usage ───────────────────────────────────────────────────────────────────
reset
OUT="$(PATH="$TMP/bin:$PATH" FAKE="$FAKE" bash "$SCRIPT" zt-production 2>&1)"; RC=$?
[[ $RC == 64 ]] && { pass=$((pass+1)); echo "ok   - missing service arguments: usage error"; } || { failn=$((failn+1)); echo "FAIL - usage (exit $RC)"; }
OUT="$(ROLLOUT_TIMEOUT_SECONDS=abc PATH="$TMP/bin:$PATH" FAKE="$FAKE" bash "$SCRIPT" zt-production "zt-production-api=$NEW" 2>&1)"; RC=$?
[[ $RC == 64 ]] && { pass=$((pass+1)); echo "ok   - non-numeric timeout rejected"; } || { failn=$((failn+1)); echo "FAIL - timeout validation (exit $RC)"; }

# ── wiring in ecs-deploy.sh ─────────────────────────────────────────────────
if grep -qE '^[^#]*aws ecs wait services-stable' "$DEPLOY"; then failn=$((failn+1)); echo "FAIL - ecs-deploy.sh still uses 'aws ecs wait services-stable'"; else pass=$((pass+1)); echo "ok   - ecs-deploy.sh no longer relies on the services-stable waiter"; fi
if grep -qE 'wait-ecs-rollout\.sh.*API_TD.*WORKER_TD' "$DEPLOY"; then pass=$((pass+1)); echo "ok   - ecs-deploy.sh waits for the task definitions it registered"; else failn=$((failn+1)); echo "FAIL - ecs-deploy.sh does not pass the registered task definitions"; fi
if grep -q 'verify-deployed-image.sh' "$DEPLOY"; then pass=$((pass+1)); echo "ok   - final verify-deployed-image.sh gate is still in the deploy path"; else failn=$((failn+1)); echo "FAIL - verify gate removed"; fi

echo; echo "passed=$pass failed=$failn"
[ "$failn" -eq 0 ]

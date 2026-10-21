#!/usr/bin/env bash
# Wait for ONE specific ECS rollout per service, and say exactly how it ended.
#
#   wait-ecs-rollout.sh <cluster> <service>=<task-definition-arn> [<service>=<task-definition-arn> ...]
#
# Why this exists: `aws ecs wait services-stable` only checks "exactly one deployment AND
# runningCount == desiredCount". It never looks at rolloutState and never at WHICH task
# definition won, so it can return while the new deployment is still IN_PROGRESS, or after the
# circuit breaker rolled back. This script polls describe-services (bounded) until the deployment
# for the task definition THIS run registered is PRIMARY + COMPLETED, alone, fully running.
#
# Exit codes (each is a different operator action):
#   0   every service: expected task definition is the only deployment, PRIMARY, COMPLETED, all tasks running
#   10  the expected deployment FAILED, or the circuit breaker rolled the service back
#   11  the service was superseded: a different task definition became PRIMARY (another deploy/update)
#   12  timed out while the rollout was still IN_PROGRESS (nothing proves it is broken - nothing proves it is fine)
#   13  AWS answered with errors / incomplete data for too many consecutive polls
#   64  usage error
#
# Environment (all optional):
#   ROLLOUT_TIMEOUT_SECONDS         overall deadline for all services together          (default 900)
#   ROLLOUT_POLL_SECONDS            seconds between polls                                 (default 15)
#   ROLLOUT_MAX_CONSECUTIVE_ERRORS  AWS errors / incomplete answers tolerated in a row    (default 5)
#   ROLLOUT_VISIBLE_GRACE_SECONDS   how long the new deployment may stay invisible       (default 60)
#
# Needs only ecs:DescribeServices (the deploy role has it). It never changes anything, never
# prints task environment, secrets or application logs - only ECS-generated service events.
set -uo pipefail

TIMEOUT="${ROLLOUT_TIMEOUT_SECONDS:-900}"
POLL="${ROLLOUT_POLL_SECONDS:-15}"
MAX_ERRORS="${ROLLOUT_MAX_CONSECUTIVE_ERRORS:-5}"
GRACE="${ROLLOUT_VISIBLE_GRACE_SECONDS:-60}"

log()  { printf '[rollout] %s\n' "$*"; }
usage() { printf '[rollout] usage: %s <cluster> <service>=<task-definition-arn>...\n' "$0" >&2; exit 64; }

[[ $# -ge 2 ]] || usage
CLUSTER="$1"; shift
for v in TIMEOUT POLL MAX_ERRORS GRACE; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { log "invalid ${v} '${!v}' (whole seconds/count expected)"; exit 64; }
done
[[ "$TIMEOUT" -ge 1 && "$MAX_ERRORS" -ge 1 ]] || { log "timeout and max errors must be >= 1"; exit 64; }

SVC=(); WANT=()
for pair in "$@"; do
  [[ "$pair" == *=* && -n "${pair%%=*}" && -n "${pair#*=}" ]] || usage
  SVC+=("${pair%%=*}"); WANT+=("${pair#*=}")
done
N=${#SVC[@]}

DONE=(); ERRS=(); SEEN=(); LASTMSG=()
for ((i = 0; i < N; i++)); do DONE[i]=0; ERRS[i]=0; SEEN[i]=0; LASTMSG[i]=""; done

ERRFILE="$(mktemp)"; trap 'rm -f "$ERRFILE"' EXIT

DEPLOY_Q='services[0].deployments[].[id,status,rolloutState,taskDefinition,desiredCount,runningCount,pendingCount,failedTasks,rolloutStateReason]'
EVENT_Q='services[0].events[:20].[createdAt,message]'

short() { printf '%s' "${1##*/}"; }

# classify <index>  ->  VERDICT (OK|PENDING|FAILED|SUPERSEDED|AWS_ERROR) and DETAIL
classify() {
  local i="$1" svc="${SVC[$1]}" want="${WANT[$1]}" out rc
  VERDICT=""; DETAIL=""
  out="$(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --query "$DEPLOY_Q" --output text 2>"$ERRFILE")"; rc=$?
  if [[ $rc -ne 0 ]]; then
    VERDICT=AWS_ERROR; DETAIL="describe-services failed (exit ${rc}): $(head -c 300 "$ERRFILE" | tr '\n' ' ')"; return
  fi

  local id status rollout td desired running pending failed reason
  local n=0 p_td="" p_rollout="" p_desired="" p_running="" p_pending="" want_failed=0 want_present=0 want_nonprimary=0
  while IFS=$'\t' read -r id status rollout td desired running pending failed reason; do
    [[ -n "$id" ]] || continue
    case "$status" in PRIMARY | ACTIVE | INACTIVE) ;; *) VERDICT=AWS_ERROR; DETAIL="unrecognised deployment row '${id:0:60}'"; return ;; esac
    case "$rollout" in IN_PROGRESS | COMPLETED | FAILED) ;; *) VERDICT=AWS_ERROR; DETAIL="deployment ${id} has no usable rolloutState ('${rollout}')"; return ;; esac
    n=$((n + 1))
    if [[ "$status" == PRIMARY ]]; then p_td="$td"; p_rollout="$rollout"; p_desired="$desired"; p_running="$running"; p_pending="$pending"; fi
    if [[ "$td" == "$want" ]]; then
      want_present=1
      [[ "$rollout" == FAILED ]] && want_failed=1
      [[ "$status" != PRIMARY ]] && want_nonprimary=1
    fi
  done <<<"$out"

  if [[ -z "$p_td" ]]; then VERDICT=AWS_ERROR; DETAIL="no PRIMARY deployment in the answer"; return; fi

  if [[ "$p_td" == "$want" ]]; then SEEN[i]=1; fi

  if [[ "$want_failed" == 1 ]]; then
    VERDICT=FAILED
    if [[ "$p_td" == "$want" ]]; then DETAIL="deployment of $(short "$want") is FAILED"
    else DETAIL="deployment of $(short "$want") FAILED and the service was rolled back to $(short "$p_td")"; fi
    return
  fi

  if [[ "$p_td" != "$want" ]]; then
    if [[ "${SEEN[i]}" == 0 && "$want_present" == 0 && "$SECONDS" -lt $((START + GRACE)) ]]; then
      VERDICT=PENDING; DETAIL="new deployment ($(short "$want")) not visible yet; PRIMARY is $(short "$p_td")"; return
    fi
    VERDICT=SUPERSEDED
    DETAIL="PRIMARY is $(short "$p_td"), not the $(short "$want") this run registered"
    [[ "$want_nonprimary" == 1 ]] && DETAIL="${DETAIL} (expected revision still listed as non-primary)"
    return
  fi

  case "$p_rollout" in
    IN_PROGRESS) VERDICT=PENDING; DETAIL="PRIMARY ${p_rollout}: running ${p_running}/${p_desired}, pending ${p_pending}, ${n} deployment(s)" ;;
    COMPLETED)
      if [[ "$n" == 1 && "$p_running" == "$p_desired" && "$p_pending" == 0 && "$p_desired" =~ ^[0-9]+$ && "$p_desired" -ge 1 ]]; then
        VERDICT=OK; DETAIL="PRIMARY COMPLETED alone, running ${p_running}/${p_desired}"
      else
        VERDICT=PENDING; DETAIL="PRIMARY COMPLETED but ${n} deployment(s), running ${p_running}/${p_desired}, pending ${p_pending}"
      fi ;;
  esac
}

# diagnostics <index> : deployments + the last ECS service events. ECS-generated text only.
diagnostics() {
  local i="$1" svc="${SVC[$1]}"
  log "---- ${svc}: expected $(short "${WANT[$1]}") ----"
  log "deployments (id status rollout taskdef desired running pending failedTasks reason):"
  aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --query "$DEPLOY_Q" --output text 2>&1 | head -c 4000 | sed 's/^/[rollout]   /'
  log "recent service events (newest first; task health-check and placement failures appear here):"
  aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --query "$EVENT_Q" --output text 2>&1 | head -c 6000 | sed 's/^/[rollout]   /'
  log "task logs, if needed:  aws logs tail /ziyaratech/${CLUSTER#zt-}/${svc##*-} --since 30m"
}

# events_mention_rollback <index> : did ECS itself say it rolled back?
events_mention_rollback() {
  aws ecs describe-services --cluster "$CLUSTER" --services "${SVC[$1]}" --query "$EVENT_Q" --output text 2>/dev/null \
    | grep -Eiq 'circuit breaker|rolling back|rolled back'
}

finish() { # code message index...
  local code="$1" msg="$2"; shift 2
  printf '::error::%s\n' "$msg"
  log "RESULT: ${msg}"
  local i; for i in "$@"; do diagnostics "$i"; done
  log "database: migrations ran BEFORE this rollout and are NOT reverted (they must stay compatible with the previous image). Re-running the same SHA is safe: applied migrations are skipped."
  exit "$code"
}

START=$SECONDS
DEADLINE=$((START + TIMEOUT))
log "waiting for ${N} service(s) in ${CLUSTER}: timeout ${TIMEOUT}s, poll ${POLL}s"

while :; do
  pending_any=0
  for ((i = 0; i < N; i++)); do
    [[ "${DONE[i]}" == 1 ]] && continue
    classify "$i"
    if [[ "$VERDICT" != AWS_ERROR ]]; then ERRS[i]=0; fi
    case "$VERDICT" in
      OK) DONE[i]=1; log "${SVC[i]}: ${DETAIL}" ;;
      PENDING) pending_any=1
        [[ "$DETAIL" == "${LASTMSG[i]}" ]] || { log "${SVC[i]}: ${DETAIL}"; LASTMSG[i]="$DETAIL"; } ;;
      FAILED) finish 10 "${SVC[i]}: ${DETAIL}" "$i" ;;
      SUPERSEDED)
        if events_mention_rollback "$i"; then finish 10 "${SVC[i]}: rolled back by ECS - ${DETAIL}" "$i"; fi
        finish 11 "${SVC[i]}: superseded - ${DETAIL}" "$i" ;;
      AWS_ERROR) pending_any=1; ERRS[i]=$((ERRS[i] + 1))
        log "${SVC[i]}: ${DETAIL} (${ERRS[i]}/${MAX_ERRORS})"
        [[ "${ERRS[i]}" -lt "$MAX_ERRORS" ]] || finish 13 "${SVC[i]}: ${MAX_ERRORS} consecutive AWS errors / incomplete answers - cannot determine the rollout state" "$i" ;;
    esac
  done

  if [[ "$pending_any" == 0 ]]; then log "all ${N} service(s) rolled out to the expected task definition"; exit 0; fi

  remaining=$((DEADLINE - SECONDS))
  if [[ "$remaining" -le 0 ]]; then
    stuck=(); for ((i = 0; i < N; i++)); do [[ "${DONE[i]}" == 1 ]] || stuck+=("$i"); done
    finish 12 "timed out after ${TIMEOUT}s: rollout still not PRIMARY+COMPLETED (${#stuck[@]} service(s))" "${stuck[@]}"
  fi
  sleep "$((POLL < remaining ? POLL : remaining))"
done

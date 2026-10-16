#!/usr/bin/env bash
# ZiyaraTech manual power switch (infra/docs/POWER-SWITCH.md).
#
#   zt-power.sh install            create ~/bin/zt-start, zt-stop, zt-status
#   zt-power.sh stop   [--yes] [--dry-run]
#   zt-power.sh start  [--dry-run]
#   zt-power.sh status
#
# Runs from AWS CloudShell (aws cli v2, jq, curl). Pinned to account 270370109141 / eu-central-1.
#
# STOP : API -> worker scaled to 0 (autoscaling min/max parked at 0), then RDS stopped if it is
#        Single-AZ. KEPT (never touched): RDS data/backups/KMS, Valkey, ALB, NAT, WAF, ECR, DNS.
# START: networking check -> RDS start -> Valkey check -> image check -> restore autoscaling +
#        desired counts -> wait healthy -> ALB target health + /health + readiness.
#
# State machine (SSM): stopping -> stopped | partial ; starting -> running | partial. "partial" is
# written automatically when a run fails after it began changing things; it keeps the original
# restore values and the next zt-start / zt-stop resumes from it.
# Cross-session lock: SSM parameter /ziyaratech/<env>/power-lock, created atomically (no --overwrite);
# never auto-expires; remove a dead one with `zt-power.sh unlock --yes`.
#
# Restore values (desired/min/max per service) live in SSM Parameter Store
# (/ziyaratech/production/power-state, plain JSON, no secrets). The script never registers a
# task definition: it restarts the services on the revision they already point to and refuses a
# `bootstrap` image. Terraform ignores desired_count and task_definition on the services; the
# only TF-visible effect of a stop is autoscaling min/max = 0, reverted by start.
set -Eeuo pipefail

readonly EXPECTED_ACCOUNT="270370109141"
readonly REGION="eu-central-1"
ENVNAME="${ZT_ENV:-production}"
CLUSTER="${ZT_CLUSTER:-zt-${ENVNAME}}"
API_SVC="${CLUSTER}-api"
WORKER_SVC="${CLUSTER}-worker"
DB_ID="${ZT_DB_ID:-${CLUSTER}-pg}"
CACHE_ID="${ZT_CACHE_ID:-${CLUSTER}-valkey}"
TG_NAME="${ZT_TG_NAME:-${CLUSTER}-api}"
LB_NAME="${ZT_LB_NAME:-${CLUSTER}-api}"
API_URL="${ZT_API_URL:-https://api.ziyaratech.com}"
STATE_PARAM="${ZT_STATE_PARAM:-/ziyaratech/${ENVNAME}/power-state}"
LOCK_PARAM="${ZT_LOCK_PARAM:-/ziyaratech/${ENVNAME}/power-lock}"
T_ECS="${ZT_TIMEOUT_ECS:-900}"       # seconds, service steady state
T_STOP="${ZT_TIMEOUT_DRAIN:-300}"    # seconds, tasks to stop (worker stopTimeout is 90 s)
T_RDS="${ZT_TIMEOUT_RDS:-1800}"
T_CACHE="${ZT_TIMEOUT_CACHE:-900}"
T_HTTP="${ZT_TIMEOUT_HTTP:-300}"
POLL="${ZT_POLL:-15}"

DRY=0; YES=0
ERRF="$(mktemp)"; CMD=""
STATE_OWNED=0; LOCK_HELD=0; LOCK_TOKEN=""
on_exit() {
  local rc=$? cur
  # A run that began changing things and then failed marks the state "partial" (original restore
  # values kept). Skipped when the failure was a concurrent state change: that state is not ours.
  if [[ $rc -ne 0 && $STATE_OWNED -eq 1 && $DRY -eq 0 ]]; then
    cur="$(command aws --region "$REGION" ssm get-parameter --name "$STATE_PARAM" --query Parameter.Value --output text 2>/dev/null || true)"
    if [[ "$(jq -r '.status // empty' <<<"${cur:-null}" 2>/dev/null)" =~ ^(stopping|starting)$ ]]; then
      command aws --region "$REGION" ssm put-parameter --name "$STATE_PARAM" --type String --overwrite \
        --value "$(jq -c --arg c "$CMD" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.status="partial"|.failedDuring=$c|.failedAt=$t' <<<"$cur")" >/dev/null 2>&1 \
        && printf '[zt] state recorded as "partial" (restore values kept).\n' >&2 \
        || printf '[zt] WARNING: could not record "partial"; state stays as written. Run zt-status.\n' >&2
    fi
  fi
  lock_release
  rm -f "$ERRF"
  if [[ $rc -ne 0 && ( "$CMD" == start || "$CMD" == stop ) ]]; then
    printf '[zt] exited with code %s. Re-run the same command to resume (see POWER-SWITCH.md, Recovery).\n' "$rc" >&2
  fi
  return 0
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say()  { printf '[zt %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[zt %s] WARNING: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { printf '[zt %s] ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit 1; }

# Read-only call: fails the script with the AWS error text.
Q() {
  local out
  out="$(command aws --region "$REGION" --cli-connect-timeout 10 --cli-read-timeout 60 "$@" 2>"$ERRF")" \
    || die "aws $1 $2 failed: $(head -c 300 "$ERRF" | tr '\n' ' ')"
  printf '%s
' "$out"
}
# Mutating call: printed instead of run under --dry-run.
M() {
  if (( DRY )); then say "[dry-run] aws $*"; return 0; fi
  Q "$@" >/dev/null
}

guard() {
  for t in aws jq curl date; do command -v "$t" >/dev/null || die "$t is required"; done
  [[ "$ENVNAME" =~ ^(production|staging)$ ]] || die "ZT_ENV must be production or staging (got '$ENVNAME')"
  [[ "$CLUSTER" == zt-* ]] || die "cluster '$CLUSTER' is not a zt-* cluster"
  for v in AWS_REGION AWS_DEFAULT_REGION; do
    [[ -z "${!v:-}" || "${!v}" == "$REGION" ]] || die "$v=${!v} but this tool only operates in $REGION"
  done
  local acct
  acct="$(Q sts get-caller-identity --query Account --output text)"
  [[ "$acct" == "$EXPECTED_ACCOUNT" ]] || die "running in account $acct, expected $EXPECTED_ACCOUNT"
  say "account $acct, region $REGION, cluster $CLUSTER$( ((DRY)) && echo ' (DRY RUN)')"
}

# ── State (SSM) ──────────────────────────────────────────────────────────────
state_get() {
  local out
  if out="$(command aws --region "$REGION" ssm get-parameter --name "$STATE_PARAM" \
        --query Parameter.Value --output text 2>"$ERRF")"; then
    printf '%s' "$out"
  elif grep -q ParameterNotFound "$ERRF"; then
    printf ''
  else
    die "cannot read state $STATE_PARAM: $(head -c 300 "$ERRF" | tr '\n' ' ')"
  fi
}
state_valid() { # json -> 0 when it is a state document this tool wrote
  jq -e '. as $d | type=="object"
    and any(["stopping","stopped","partial","starting","running"][]; . == $d.status)
    and ([$d.api,$d.worker] | all(type=="object"
         and (.desired|type=="number") and (.min|type=="number") and (.max|type=="number")
         and (.taskDef|type=="string") and .desired>=0 and .min>=0 and .max>=.min))' <<<"$1" >/dev/null 2>&1
}
state_load() { # echoes state json or empty; dies on corrupt state
  local st; st="$(state_get)"
  if [[ -n "$st" ]] && ! state_valid "$st"; then
    die "state $STATE_PARAM is corrupt/unrecognised. Inspect it (aws ssm get-parameter --name $STATE_PARAM), then either fix it or delete it and pass ZT_API_RESTORE / ZT_WORKER_RESTORE as desired,min,max."
  fi
  if [[ -n "$st" ]]; then
    local ts age; ts="$(jq -r '.stoppedAt // .startedStopAt // empty' <<<"$st")"
    if age="$(date -u -d "$ts" +%s 2>/dev/null)" && (( $(date -u +%s) - age > 30*86400 )); then
      warn "saved state is older than 30 days ($ts); restore values may be stale. Live values win for any service that is running."
    fi
  fi
  printf '%s' "$st"
}
state_expect() { # status... : abort if another operator/run changed the state under us
  (( DRY )) && return 0
  local cur x; cur="$(jq -r '.status // empty' <<<"$(state_get)")"
  for x in "$@"; do [[ "$cur" == "$x" ]] && return 0; done
  STATE_OWNED=0   # not ours any more: do not mark it "partial" on exit
  die "state changed during this run (now '${cur:-missing}', expected $*): another zt-start/zt-stop may be running elsewhere. Stopping here; run zt-status."
}
state_put() { # json
  if (( DRY )); then say "[dry-run] would write state to $STATE_PARAM"; return 0; fi
  Q ssm put-parameter --name "$STATE_PARAM" --type String --overwrite --value "$1" >/dev/null
  STATE_OWNED=1
}

# ── Cross-session lock (SSM create-if-absent is atomic: a second creator gets ParameterAlreadyExists) ──
lock_peek() { # echoes holder json or empty
  command aws --region "$REGION" ssm get-parameter --name "$LOCK_PARAM" --query Parameter.Value --output text 2>/dev/null || true
}
lock_acquire() {
  if (( DRY )); then
    local h; h="$(lock_peek)"
    [[ -z "$h" ]] || warn "[dry-run] a real run would be refused: lock held by $h"
    return 0
  fi
  LOCK_TOKEN="$(date -u +%s)-$$-$RANDOM"
  local val; val="$(jq -nc --arg c "$CMD" --arg o "$(id -un)@$(hostname)" --arg t "$(now)" --arg k "$LOCK_TOKEN" '{cmd:$c,owner:$o,at:$t,token:$k}')"
  if command aws --region "$REGION" ssm put-parameter --name "$LOCK_PARAM" --type String --value "$val" >/dev/null 2>"$ERRF"; then
    LOCK_HELD=1; say "lock acquired ($LOCK_PARAM)"
  elif grep -q ParameterAlreadyExists "$ERRF"; then
    die "another zt run holds the lock: $(lock_peek). Wait for it, or if that run is dead: zt-power.sh unlock --yes"
  else
    die "cannot acquire lock $LOCK_PARAM: $(head -c 300 "$ERRF" | tr '\n' ' ')"
  fi
}
lock_release() {
  (( LOCK_HELD )) || return 0
  LOCK_HELD=0
  local cur; cur="$(lock_peek)"
  if [[ "$(jq -r '.token // empty' <<<"${cur:-null}" 2>/dev/null)" == "$LOCK_TOKEN" ]]; then
    command aws --region "$REGION" ssm delete-parameter --name "$LOCK_PARAM" >/dev/null 2>&1 \
      || printf '[zt] WARNING: could not release lock; remove it with: zt-power.sh unlock --yes\n' >&2
  else
    printf '[zt] WARNING: lock %s is no longer ours; left untouched.\n' "$LOCK_PARAM" >&2
  fi
}
do_unlock() {
  guard
  local h; h="$(lock_peek)"
  [[ -n "$h" ]] || { say "no lock present"; return 0; }
  say "lock: $h"
  (( YES )) || die "refusing to remove it without --yes (only do this if that run is dead; check zt-status first)"
  M ssm delete-parameter --name "$LOCK_PARAM"; say "lock removed"
}
dry_summary() {
  say "DRY RUN complete: NO AWS mutation was performed (no scaling, RDS, SSM state or lock writes)."
  say "NOT checked in dry-run: task drain, RDS reaching stopped/available, service steady state, Valkey wait, ALB target health, /api/v1/health, readiness."
}

# ── Helpers ──────────────────────────────────────────────────────────────────
svc_json() { Q ecs describe-services --cluster "$CLUSTER" --services "$1" --query 'services[0]' --output json; }
svc_check() { # fails unless the service exists and is ACTIVE
  local s; s="$(svc_json "$1")"
  [[ "$(jq -r '.status // "MISSING"' <<<"$s")" == "ACTIVE" ]] || die "ECS service $1 is not ACTIVE (found: $(jq -r '.status // "missing"' <<<"$s"))"
}
as_target() { Q application-autoscaling describe-scalable-targets --service-namespace ecs \
  --resource-ids "service/$CLUSTER/$1" --query 'ScalableTargets[0]' --output json; }
as_set() { # service min max
  local t; t="$(as_target "$1")"
  if [[ -z "$t" || "$t" == null ]]; then warn "no Application Auto Scaling target for $1; autoscaling left untouched"; return 0; fi
  M application-autoscaling register-scalable-target --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount --resource-id "service/$CLUSTER/$1" \
    --min-capacity "$2" --max-capacity "$3"
}
capture() { # service -> {"desired","min","max","taskDef"}
  local s t; s="$(svc_json "$1")"; t="$(as_target "$1")"
  jq -n --argjson s "$s" --argjson t "${t:-null}" \
    '{desired:$s.desiredCount, min:($t.MinCapacity // $s.desiredCount), max:($t.MaxCapacity // $s.desiredCount), taskDef:$s.taskDefinition}'
}
override() { # NAME current-json -> json with ZT_<NAME>_RESTORE="desired,min,max" applied
  local v="ZT_${1}_RESTORE"
  if [[ -n "${!v:-}" ]]; then
    IFS=, read -r d mn mx <<<"${!v}"
    [[ "$d$mn$mx" =~ ^[0-9]+$ ]] || die "$v must be desired,min,max (integers)"
    jq --argjson d "$d" --argjson mn "$mn" --argjson mx "$mx" '.desired=$d|.min=$mn|.max=$mx' <<<"$2"
  else printf '%s' "$2"; fi
}
resolve() { # NAME service saved-json-or-empty -> restore values (live wins when the service is running)
  local live base v="ZT_${1}_RESTORE"
  live="$(capture "$2")"
  if jq -e '.desired>0 and .max>0' <<<"$live" >/dev/null; then
    base="$live"; [[ -z "$3" ]] || say "$1: running now, using live values (saved ones ignored)" >&2
  elif [[ -n "$3" ]]; then base="$3"
  elif [[ -n "${!v:-}" ]]; then base="$live"
  else die "$1 is at 0 and there are no saved restore values. Set $v=desired,min,max (Terraform: api 2,2,6 worker 1,1,3)."; fi
  override "$1" "$base"
}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

wait_until() { # description timeout command... (command succeeds when done)
  local what="$1" limit="$2"; shift 2
  (( DRY )) && { say "[dry-run] would wait for: $what"; return 0; }
  local start=$SECONDS
  until "$@"; do
    (( SECONDS - start < limit )) || { warn "timed out after ${limit}s waiting for: $what"; return 1; }
    sleep "$POLL"
  done
  say "ok: $what"
}
tasks_gone() { # service
  local s; s="$(svc_json "$1")"
  [[ "$(jq '.runningCount + .pendingCount' <<<"$s")" == "0" ]]
}
svc_steady() { # service desired expectedTaskDef
  local s; s="$(svc_json "$1")"
  jq -e --argjson d "$2" --arg td "$3" '
    .runningCount==$d and .pendingCount==0 and .taskDefinition==$td
    and ([.deployments[]|select(.status=="PRIMARY")|.rolloutState]|all(.=="COMPLETED"))
    and (.deployments|length)==1' <<<"$s" >/dev/null
}
rds_field() { Q rds describe-db-instances --db-instance-identifier "$DB_ID" --query "DBInstances[0].$1" --output text; }
rds_is() { [[ "$(rds_field DBInstanceStatus)" == "$1" ]]; }

# ── STOP ─────────────────────────────────────────────────────────────────────
do_stop() {
  guard
  lock_acquire
  svc_check "$API_SVC"; svc_check "$WORKER_SVC"
  local st api wk
  st="$(state_load)"
  api="$(resolve API "$API_SVC" "$([[ -n $st ]] && jq -c .api <<<"$st")")"
  wk="$(resolve WORKER "$WORKER_SVC" "$([[ -n $st ]] && jq -c .worker <<<"$st")")"
  [[ -z "$st" ]] || say "saved state: $(jq -r .status <<<"$st")"
  say "restore plan  api=$(jq -c 'del(.taskDef)' <<<"$api")  worker=$(jq -c 'del(.taskDef)' <<<"$wk")"

  # Visibility into RDS before anything is touched.
  local multi cls retention
  multi="$(rds_field MultiAZ)"; cls="$(rds_field DBInstanceClass)"; retention="$(rds_field BackupRetentionPeriod)"
  say "RDS $DB_ID: class=$cls multiAZ=$multi backupRetention=${retention}d status=$(rds_field DBInstanceStatus)"
  [[ "$retention" =~ ^[0-9]+$ && "$retention" -gt 0 ]] || warn "RDS backup retention is $retention (expected > 0); this tool does not change it."

  if (( ! YES && ! DRY )); then
    cat <<EOF

About to make ZiyaraTech UNAVAILABLE:
  * API + worker tasks stop (in-flight HTTP requests end; worker drains up to 90 s, longer jobs are
    re-queued by BullMQ). Tap webhooks / WhatsApp / email callbacks sent meanwhile get 503s.
  * Autoscaling min/max parked at 0 (Terraform will show this drift until zt-start).
  * RDS $DB_ID is stopped if Single-AZ (multiAZ=$multi). AWS auto-starts it after 7 days.
  * KEPT and still billed: ALB, NAT, Valkey, WAF, RDS storage + backups, CloudWatch, KMS, ECR.
EOF
    read -r -p "Type 'yes' to continue: " ans; [[ "$ans" == "yes" ]] || die "cancelled"
  fi

  state_put "$(jq -n --argjson a "$api" --argjson w "$wk" --arg t "$(now)" \
    '{status:"stopping", startedStopAt:$t, api:$a, worker:$w}')"

  # API first: stop taking new requests/webhooks, then let the worker drain.
  say "stopping API"
  as_set "$API_SVC" 0 0
  M ecs update-service --cluster "$CLUSTER" --service "$API_SVC" --desired-count 0
  wait_until "API tasks stopped" "$T_STOP" tasks_gone "$API_SVC" || die "API tasks did not stop; re-run zt-stop"

  say "stopping worker (SIGTERM, 90 s BullMQ drain)"
  as_set "$WORKER_SVC" 0 0
  M ecs update-service --cluster "$CLUSTER" --service "$WORKER_SVC" --desired-count 0
  wait_until "worker tasks stopped" "$T_STOP" tasks_gone "$WORKER_SVC" || die "worker tasks did not stop; re-run zt-stop"

  state_expect stopping

  # RDS: only Single-AZ instances can be stopped; Multi-AZ is never modified.
  # "stopped" is written only after RDS really reached 'stopped' (or Multi-AZ was knowingly left running).
  local rst rds_final; rst="$(rds_field DBInstanceStatus)"
  if [[ "$multi" == "True" ]]; then
    warn "RDS is Multi-AZ: AWS cannot stop it and this tool will not change its availability. Left running."
    rds_final="left-running-multi-az"
  elif [[ "$rst" == "stopped" ]]; then
    say "RDS already stopped"; rds_final="stopped"
  else
    if [[ "$rst" != "stopping" ]]; then
      wait_until "RDS available" "$T_RDS" rds_is available || die "RDS is '$rst' and did not become available in ${T_RDS}s (backup/maintenance?). ECS is stopped; state is 'partial'. Re-run zt-stop later."
      say "stopping RDS $DB_ID (data, storage and backups are retained)"
      M rds stop-db-instance --db-instance-identifier "$DB_ID"
    fi
    wait_until "RDS stopped" "$T_RDS" rds_is stopped || die "RDS did not reach 'stopped' within ${T_RDS}s. ECS is stopped; state is 'partial'. Re-run zt-stop (it resumes; check the RDS console/events)."
    rds_final="stopped"
  fi

  state_expect stopping
  state_put "$(jq -n --argjson a "$api" --argjson w "$wk" --arg t "$(now)" --arg m "$multi" --arg r "$rds_final" \
    '{status:"stopped", stoppedAt:$t, rdsMultiAZ:$m, rds:$r, api:$a, worker:$w}')"
  STATE_OWNED=0
  say "stopped."; do_status
  if (( DRY )); then dry_summary; fi
}

# ── START ────────────────────────────────────────────────────────────────────
route_table_for() { # subnet -> route-table JSON governing it: explicit association, else the VPC main table
  local rt vpc
  rt="$(Q ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$1" --output json)"
  if [[ "$(jq '.RouteTables|length' <<<"$rt")" == 0 ]]; then
    vpc="$(Q ec2 describe-subnets --subnet-ids "$1" --query 'Subnets[0].VpcId' --output text)"
    rt="$(Q ec2 describe-route-tables --filters "Name=vpc-id,Values=$vpc" "Name=association.main,Values=true" --output json)"
    [[ "$(jq '.RouteTables|length' <<<"$rt")" == 1 ]] || die "no explicit or main route table found for subnet $1"
  fi
  printf '%s' "$rt"
}
check_network() {
  local subnets s rt def state nat natstate n=0
  subnets="$(svc_json "$API_SVC" | jq -r '.networkConfiguration.awsvpcConfiguration.subnets[]' | sort -u)"
  [[ -n "$subnets" ]] || die "cannot determine the API service subnets"
  for s in $subnets; do
    n=$((n+1))
    rt="$(route_table_for "$s")"
    def="$(jq -c '.RouteTables[0].Routes | map(select(.DestinationCidrBlock=="0.0.0.0/0")) | .[0] // empty' <<<"$rt")"
    [[ -n "$def" ]] || die "subnet $s has no default route (0.0.0.0/0); egress to Tap/Meta/OpenAI/ECR would fail. Fix routing via Terraform before starting."
    state="$(jq -r '.State // "unknown"' <<<"$def")"
    [[ "$state" == "active" ]] || die "subnet $s default route is '$state' (blackhole). Fix the route to a live NAT via Terraform, then re-run."
    nat="$(jq -r '.NatGatewayId // empty' <<<"$def")"
    if [[ -n "$nat" ]]; then
      natstate="$(Q ec2 describe-nat-gateways --nat-gateway-ids "$nat" --query 'NatGateways[0].State' --output text)"
      [[ "$natstate" == "available" ]] || die "NAT $nat for subnet $s is '$natstate'"
    else
      warn "subnet $s default route target is $(jq -r '.GatewayId // .TransitGatewayId // .NetworkInterfaceId // "unknown"' <<<"$def"), not a NAT gateway; not verified further"
    fi
  done
  say "networking ok: active default route on $n app subnet(s) (explicit or main route table)"
}

public_ecr_exists() { # path (alias/repo[:tag|@digest]) -> 0 when the manifest exists; anonymous, read-only
  local path="$1" repo ref tok code
  repo="${path%%[:@]*}"; ref="${path#"$repo"}"; ref="${ref#[:@]}"
  tok="$(curl -fsS --max-time 15 "https://public.ecr.aws/token/" | jq -r '.token // empty')" || return 1
  [[ -n "$tok" ]] || return 1
  code="$(curl -s -o /dev/null -I -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://public.ecr.aws/v2/$repo/manifests/$ref")" || return 1
  [[ "$code" == 200 ]]
}
check_one_image() { # service image
  local svc="$1" img="$2" host path repo ref
  host="${img%%/*}"; path="${img#*/}"
  [[ "$img" != *:bootstrap* && "$path" == *[:@]* ]] || die "$svc points at '$img' (bootstrap/untagged). Refusing. Deploy a real image through CI first."
  repo="${path%%[:@]*}"
  if [[ "$img" == *@sha256:* ]]; then ref="imageDigest=${img##*@}"; else ref="imageTag=${img##*:}"; fi
  case "$host" in
    "$EXPECTED_ACCOUNT.dkr.ecr.$REGION.amazonaws.com")
      Q ecr describe-images --repository-name "$repo" --image-ids "$ref" --query 'imageDetails[0].imageDigest' --output text >/dev/null
      say "$svc -> $img (private ECR, present)" >&2 ;;
    *.dkr.ecr.*.amazonaws.com)
      die "$svc uses private ECR image '$img' outside account $EXPECTED_ACCOUNT / $REGION; this tool will not verify or start it." ;;
    public.ecr.aws)
      public_ecr_exists "$path" || die "$svc public image '$img' could not be confirmed on public.ecr.aws (missing tag, or CloudShell cannot reach it)."
      say "$svc -> $img (public ECR, present)" >&2 ;;
    *)
      warn "$svc image '$img' is on registry '$host': existence cannot be verified here; ECS will pull it on start." ;;
  esac
}
check_image() { # service -> echoes taskdef arn; dies on bootstrap/missing image
  local td st img
  td="$(svc_json "$1" | jq -r .taskDefinition)"
  st="$(Q ecs describe-task-definition --task-definition "$td" --query 'taskDefinition.status' --output text)"
  [[ "$st" == "ACTIVE" ]] || die "task definition $td is '$st'"
  for img in $(Q ecs describe-task-definition --task-definition "$td" --query 'taskDefinition.containerDefinitions[].image' --output text); do
    check_one_image "$1" "$img"
  done
  printf '%s' "$td"
}

check_cache() {
  local r
  r="$(Q elasticache describe-replication-groups --replication-group-id "$CACHE_ID" \
      --query 'ReplicationGroups[0].[Status,length(MemberClusters)]' --output text)"
  [[ -n "$r" && "$r" != "None" ]] || die "Valkey $CACHE_ID not found. This tool never deletes it; restore/recreate through Terraform, then re-run."
  cache_ready() { [[ "$(Q elasticache describe-replication-groups --replication-group-id "$CACHE_ID" --query 'ReplicationGroups[0].Status' --output text)" == "available" ]]; }
  wait_until "Valkey available" "$T_CACHE" cache_ready || die "Valkey is not available"
  [[ "${r##* }" -ge 2 ]] || warn "Valkey has ${r##* } member(s); expected primary + replica (failover)."
}

check_td_unchanged() { # name saved-json current-td
  local saved; saved="$(jq -r '.taskDef // empty' <<<"$2")"
  [[ -z "$saved" || "$saved" == "$3" ]] && return 0
  [[ "${ZT_ACCEPT_TASKDEF_CHANGE:-0}" == "1" ]]     || die "$1 service now runs ${3##*/} but was stopped on ${saved##*/} (a deploy happened while stopped?). Review it, then re-run with ZT_ACCEPT_TASKDEF_CHANGE=1."
  warn "$1 runs ${3##*/} (was ${saved##*/}); accepted by ZT_ACCEPT_TASKDEF_CHANGE=1"
}
clamp_desired() { jq -r '[.min, ([.desired, .max]|min)]|max' <<<"$1"; }
restore_service() { # service json desired
  local mn mx; mn="$(jq .min <<<"$2")"; mx="$(jq .max <<<"$2")"
  say "starting $1 desired=$3 (autoscaling $mn..$mx)"
  as_set "$1" "$mn" "$mx"
  M ecs update-service --cluster "$CLUSTER" --service "$1" --desired-count "$3"
}

do_start() {
  guard
  lock_acquire
  svc_check "$API_SVC"; svc_check "$WORKER_SVC"
  local st api wk
  st="$(state_load)"
  api="$(resolve API "$API_SVC" "$([[ -n $st ]] && jq -c .api <<<"$st")")"
  wk="$(resolve WORKER "$WORKER_SVC" "$([[ -n $st ]] && jq -c .worker <<<"$st")")"
  if [[ -z "$st" ]]; then say "no saved state: using live service values"
  else say "saved state: $(jq -r .status <<<"$st") since $(jq -r '.stoppedAt // .startedStopAt // "?"' <<<"$st")"; fi
  if [[ -n "$st" ]]; then state_put "$(jq '.status="starting"' <<<"$st")"; fi

  check_network

  # RDS
  local rst; rst="$(rds_field DBInstanceStatus)"
  case "$rst" in
    stopped)  say "starting RDS $DB_ID"; M rds start-db-instance --db-instance-identifier "$DB_ID" ;;
    stopping) wait_until "RDS stopped" "$T_RDS" rds_is stopped || die "RDS stuck stopping"
              M rds start-db-instance --db-instance-identifier "$DB_ID" ;;
    failed|storage-full|restore-error|deleting|deleted|inaccessible-encryption-credentials*|incompatible-*)
              die "RDS $DB_ID is in terminal/unsafe status '$rst'. Resolve it in the RDS console; ECS was not started." ;;
    *) say "RDS status: $rst" ;;
  esac
  wait_until "RDS available" "$T_RDS" rds_is available || die "RDS not available after ${T_RDS}s. Check the RDS console/events; do not start ECS until it is available."
  local ret; ret="$(rds_field BackupRetentionPeriod)"
  [[ "$ret" =~ ^[0-9]+$ && "$ret" -gt 0 ]] && say "RDS backup retention ${ret}d" || warn "RDS backup retention is ${ret}; fix via Terraform (not changed here)."

  check_cache

  # Images / task definitions: use exactly what the services already run.
  local api_td wk_td
  api_td="$(check_image "$API_SVC")"; wk_td="$(check_image "$WORKER_SVC")"
  check_td_unchanged api "$api" "$api_td"; check_td_unchanged worker "$wk" "$wk_td"

  # Services: restore autoscaling bounds, then desired counts.
  D_api="$(clamp_desired "$api")"; D_worker="$(clamp_desired "$wk")"
  restore_service "$WORKER_SVC" "$wk" "$D_worker"
  restore_service "$API_SVC" "$api" "$D_api"
  api_ok() { svc_steady "$API_SVC" "$D_api" "$api_td"; }
  wk_ok()  { svc_steady "$WORKER_SVC" "$D_worker" "$wk_td"; }
  wait_until "worker steady" "$T_ECS" wk_ok  || die "worker not steady after ${T_ECS}s (check: aws ecs describe-services / CloudWatch logs /ziyaratech/$ENVNAME/worker). Re-run zt-start after fixing."
  wait_until "API steady"    "$T_ECS" api_ok || die "API not steady after ${T_ECS}s (circuit breaker may have rolled back). Re-run zt-start after fixing."

  verify_health "$D_api"
  if [[ -n "$st" ]]; then state_expect starting; state_put "$(jq --arg t "$(now)" '.status="running"|.startedAt=$t' <<<"$st")"; fi
  STATE_OWNED=0
  say "started."; do_status
  if (( DRY )); then dry_summary; fi
}

verify_health() { # expected healthy targets
  (( DRY )) && { say "[dry-run] would verify ALB targets and $API_URL"; return 0; }
  local tg; tg="$(Q elbv2 describe-target-groups --names "$TG_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text)"
  healthy() { [[ "$(Q elbv2 describe-target-health --target-group-arn "$tg" \
      --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text)" -ge "$1" ]]; }
  wait_until "$1 ALB target(s) healthy" "$T_HTTP" healthy "$1" || die "ALB targets not healthy; see zt-status"
  http_ok() { curl -fsS --max-time 10 "$API_URL/api/v1/health" >/dev/null 2>&1; }
  wait_until "GET /api/v1/health" "$T_HTTP" http_ok || die "$API_URL/api/v1/health not answering 200"
  local ready s
  ready="$(curl -fsS --max-time 15 "$API_URL/api/v1/system/health/readiness" 2>/dev/null || true)"
  s="$(jq -r '.status // .data.status // empty' <<<"${ready:-null}" 2>/dev/null || true)"
  [[ "$s" == "ok" || "$s" == "busy" ]] || die "readiness (DB/Redis/app) is '${s:-no answer}', not ok"
  say "readiness: $s"
}

# ── STATUS ───────────────────────────────────────────────────────────────────
do_status() {
  local sj
  say "── ECS"
  for s in "$API_SVC" "$WORKER_SVC"; do
    local j t
    j="$(svc_json "$s")"; t="$(as_target "$s")"
    jq -r --arg n "$s" --argjson t "${t:-null}" \
      '"  \($n): desired=\(.desiredCount) running=\(.runningCount) pending=\(.pendingCount) autoscaling=\($t.MinCapacity // "-")..\($t.MaxCapacity // "-") td=\(.taskDefinition|split("/")[-1])"' <<<"$j"
  done
  say "── RDS"
  local r; r="$(Q rds describe-db-instances --db-instance-identifier "$DB_ID" --output json)"
  jq -r '.DBInstances[0]|"  \(.DBInstanceIdentifier): \(.DBInstanceStatus) class=\(.DBInstanceClass) multiAZ=\(.MultiAZ) backupRetention=\(.BackupRetentionPeriod)d storage=\(.AllocatedStorage)GB"' <<<"$r"
  say "── Valkey / ALB / NAT (always on)"
  Q elasticache describe-replication-groups --replication-group-id "$CACHE_ID" \
    --query 'ReplicationGroups[0].[ReplicationGroupId,Status,CacheNodeType]' --output text | sed 's/^/  /'
  Q elbv2 describe-load-balancers --names "$LB_NAME" --query 'LoadBalancers[0].[LoadBalancerName,State.Code]' --output text | sed 's/^/  ALB /'
  local vpc
  vpc="$(Q elbv2 describe-load-balancers --names "$LB_NAME" --query 'LoadBalancers[0].VpcId' --output text)"
  Q ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$vpc" "Name=state,Values=available,pending" \
    --query 'NatGateways[].[NatGatewayId,State]' --output text | sed 's/^/  NAT /'
  local st; st="$(state_get)"
  if [[ -z "$st" ]]; then say "── power state: none"
  elif ! state_valid "$st"; then warn "power state $STATE_PARAM is CORRUPT (start/stop will refuse until fixed)"; st=""
  else say "── power state: $(jq -r .status <<<"$st") $(jq -r '(.stoppedAt // .startedAt // "")' <<<"$st")"; fi
  local lk; lk="$(lock_peek)"; [[ -z "$lk" ]] || warn "run lock present: $lk (a run is active, or it died: zt-power.sh unlock --yes)"
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL/api/v1/health" || true)"
  say "── public /api/v1/health -> HTTP ${code:-none}"
  local rs; rs="$(jq -r '.DBInstances[0].DBInstanceStatus' <<<"$r")"
  if [[ -n "$st" && "$(jq -r .status <<<"$st")" == stopped && "$(jq -r '.rdsMultiAZ // ""' <<<"$st")" != True ]]; then
    if [[ "$rs" == available || "$rs" == starting ]]; then
      warn "state says stopped but RDS is '$rs' (AWS auto-starts stopped instances after 7 days, or someone started it). It is billing again: run zt-stop to stop it."
    elif [[ "$rs" == stopped ]]; then
      local ts age; ts="$(jq -r '.stoppedAt // empty' <<<"$st")"
      if age="$(date -u -d "$ts" +%s 2>/dev/null)" && (( $(date -u +%s) - age > 6*86400 )); then
        warn "RDS has been stopped >6 days: AWS auto-starts it after 7 days and billing resumes. Run zt-stop again (or zt-start)."
      fi
    fi
  fi
  return 0
}

install_cmds() {
  local self dir="$HOME/bin" c
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  mkdir -p "$dir"
  for c in start stop status; do
    printf '#!/usr/bin/env bash\n[ -f %q ] || { echo "zt-%s: %s is missing; re-run: bash <repo>/infra/scripts/zt-power.sh install" >&2; exit 1; }\nexec bash %q %s "$@"\n' \
      "$self" "$c" "$self" "$self" "$c" > "$dir/zt-$c"
    chmod +x "$dir/zt-$c"
  done
  say "installed zt-start, zt-stop, zt-status in $dir (-> $self)"
  case ":$PATH:" in
    *":$dir:"*) say "$dir is already on PATH." ;;
    *) say "$dir is NOT on PATH. Run now:  export PATH=\"$dir:\$PATH\""
       say "Persist it:  echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.bashrc" ;;
  esac
}

# ── main ─────────────────────────────────────────────────────────────────────
cmd="${1:-}"; shift || true; CMD="$cmd"
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;; --yes|-y) YES=1 ;;
    *) die "unknown option: $a" ;;
  esac
done
LOCK="${TMPDIR:-/tmp}/zt-power.lock"
if [[ "$cmd" == start || "$cmd" == stop ]]; then
  command -v flock >/dev/null || die "flock is required"
  exec 9>"$LOCK"; flock -n 9 || die "another zt-start/zt-stop is running"
fi
case "$cmd" in
  stop)    do_stop ;;
  start)   do_start ;;
  status)  guard; do_status ;;
  install) install_cmds ;;
  unlock)  do_unlock ;;
  *) echo "usage: zt-power.sh {start|stop|status|install|unlock} [--dry-run] [--yes]" >&2; exit 2 ;;
esac

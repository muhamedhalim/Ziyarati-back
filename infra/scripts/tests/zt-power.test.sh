#!/usr/bin/env bash
# Offline test for infra/scripts/zt-power.sh. A stateful fake `aws`/`curl` (state in files) stands in
# for AWS, so nothing real is touched. Run:  bash infra/scripts/tests/zt-power.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../zt-power.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export FAKE="$TMP/state"; mkdir -p "$TMP/bin" "$FAKE"
GOOD_IMG="270370109141.dkr.ecr.eu-central-1.amazonaws.com/ziyaratech/backend:abc123"

cat > "$TMP/bin/aws" <<'EOF'
#!/usr/bin/env bash
a="$*"; f() { cat "$FAKE/$1" 2>/dev/null; }; w() { printf '%s' "$2" > "$FAKE/$1"; }
echo "${a%%$'
'*}" >> "$FAKE/calls.log"
[[ -n "${FAKE_FAIL:-}" && "$a" == *"$FAKE_FAIL"* ]] && { echo "An error occurred (Throttling): fake" >&2; exit 254; }
svc() { [[ "$a" == *"-worker"* ]] && echo worker || echo api; }
case "$a" in
 *"sts get-caller-identity"*) echo "${FAKE_ACCOUNT:-270370109141}" ;;
 *"ssm get-parameter"*) n=ssm; [[ "$a" == *power-lock* ]] && n=lock
   [[ -f "$FAKE/$n" ]] && f $n || { echo "An error occurred (ParameterNotFound)" >&2; exit 254; } ;;
 *"ssm put-parameter"*) n=ssm; [[ "$a" == *power-lock* ]] && n=lock
   if [[ "$a" != *--overwrite* && -f "$FAKE/$n" ]]; then echo "An error occurred (ParameterAlreadyExists)" >&2; exit 254; fi
   v="${a#*--value }"; w $n "$v" ;;
 *"ssm delete-parameter"*) if [[ "$a" == *power-lock* ]]; then rm -f "$FAKE/lock"; else echo "delete of non-lock parameter!" >&2; exit 99; fi ;;
 *"ecs describe-services"*) s=$(svc); d=$(f d_$s); r=$d; [[ -n "${FAKE_STUCK:-}" && $s == api ]] && r=0; [[ -n "${FAKE_WORKER_STUCK:-}" && $s == worker ]] && r=1
   echo "{\"status\":\"ACTIVE\",\"desiredCount\":$d,\"runningCount\":$r,\"pendingCount\":0,\"taskDefinition\":\"arn:aws:ecs:r:a:task-definition/zt-production-$s:$(f td_$s)\",\"networkConfiguration\":{\"awsvpcConfiguration\":{\"subnets\":[\"subnet-1\",\"subnet-2\"]}},\"deployments\":[{\"status\":\"PRIMARY\",\"rolloutState\":\"COMPLETED\"}]}" ;;
 *"ecs update-service"*) s=$(svc); x="${a#*--desired-count }"; w d_$s "${x%% *}"
   if [[ -n "${FAKE_FLIP:-}" && $s == worker ]]; then sed -i 's/"status": *"stopping"/"status":"starting"/' "$FAKE/ssm"; fi ;;
 *"describe-scalable-targets"*) s=$(svc); echo "{\"MinCapacity\":$(f min_$s),\"MaxCapacity\":$(f max_$s)}" ;;
 *"register-scalable-target"*) s=$(svc); x="${a#*--min-capacity }"; w min_$s "${x%% *}"; x="${a#*--max-capacity }"; w max_$s "${x%% *}" ;;
 *"rds describe-db-instances"*)
   if [[ "$a" == *"--output json"* ]]; then echo "{\"DBInstances\":[{\"DBInstanceIdentifier\":\"zt-production-pg\",\"DBInstanceStatus\":\"$(f rds)\",\"DBInstanceClass\":\"db.t3.small\",\"MultiAZ\":$(f multi),\"BackupRetentionPeriod\":$(f ret),\"AllocatedStorage\":50}]}";
   else case "$a" in *DBInstanceClass*) echo db.t3.small;; *DBInstanceStatus*) v=$(f rds); if [[ $v == backing-up ]]; then n=$(( $(f cnt || echo 0) + 1 )); w cnt $n; (( n >= 4 )) && w rds available; fi; echo "$v";; *MultiAZ*) [[ $(f multi) == true ]] && echo True || echo False;; *Backup*) f ret;; esac; fi ;;
 *"rds stop-db-instance"*) if [[ $(f rds) != available ]]; then echo "An error occurred (InvalidDBInstanceState): not available" >&2; exit 254; fi; w rds stopped ;;
 *"rds start-db-instance"*) w rds available ;;
 *"elasticache describe-replication-groups"*) case "$a" in *"[Status,length"*) echo "available 2";; *Status*) echo available;; *) echo "zt-production-valkey available cache.t4g.micro";; esac ;;
 *"ec2 describe-route-tables"*) mode="${FAKE_ROUTE_MODE:-explicit}"; st=active; tgt='"NatGatewayId":"nat-1"'
   [[ $mode == blackhole || $mode == mainblackhole ]] && st=blackhole; [[ $mode == igw ]] && tgt='"GatewayId":"igw-1"'
   rt="{\"RouteTables\":[{\"Routes\":[{\"DestinationCidrBlock\":\"10.20.0.0/16\",\"GatewayId\":\"local\",\"State\":\"active\"},{\"DestinationCidrBlock\":\"0.0.0.0/0\",$tgt,\"State\":\"$st\"}]}]}"
   [[ $mode == nodefault ]] && rt='{"RouteTables":[{"Routes":[{"DestinationCidrBlock":"10.20.0.0/16","GatewayId":"local","State":"active"}]}]}'
   if [[ "$a" == *association.subnet-id* ]]; then
     case $mode in main|mainblackhole|nomain) echo '{"RouteTables":[]}';; *) echo "$rt";; esac
   else [[ $mode == nomain ]] && echo '{"RouteTables":[]}' || echo "$rt"; fi ;;
 *"ec2 describe-subnets"*) echo vpc-1 ;;
 *"ec2 describe-nat-gateways"*) [[ "$a" == *NatGatewayId* ]] && echo "nat-1 available" || echo "${FAKE_NAT_STATE:-available}" ;;
 *"ecs describe-task-definition"*) [[ "$a" == *"taskDefinition.status"* ]] && echo ACTIVE || echo "${FAKE_IMG}" ;;
 *"ecr describe-images"*) case "$a" in *"--repository-name ziyaratech/backend "*) echo sha256:aaaa;; *) echo "An error occurred (RepositoryNotFoundException)" >&2; exit 254;; esac ;;
 *"elbv2 describe-target-groups"*) echo arn:tg ;;
 *"elbv2 describe-target-health"*) echo 2 ;;
 *"elbv2 describe-load-balancers"*) case "$a" in *VpcId*) echo vpc-1;; *) echo "zt-production-api active";; esac ;;
 *) echo "fake aws: unhandled: $a" >&2; exit 99 ;;
esac
EOF
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/curl.log"
[[ "$*" == *public.ecr.aws/token* ]] && { echo '{"token":"anon"}'; exit 0; }
[[ "$*" == *public.ecr.aws/v2/* ]] && { echo "${FAKE_PUBLIC_CODE:-200}"; exit 0; }
[[ "$*" == *http_code* ]] && { echo 200; exit 0; }
[[ -n "${FAKE_HTTP_DOWN:-}" ]] && exit 22
[[ "$*" == *readiness* ]] && echo '{"status":"ok"}'; exit 0
EOF
chmod +x "$TMP/bin/aws" "$TMP/bin/curl"

reset() { rm -rf "$FAKE"; mkdir -p "$FAKE"
  echo 2 > "$FAKE/d_api"; echo 1 > "$FAKE/d_worker"; echo 2 > "$FAKE/min_api"; echo 6 > "$FAKE/max_api"
  echo 1 > "$FAKE/min_worker"; echo 3 > "$FAKE/max_worker"; echo 21 > "$FAKE/td_api"; echo 17 > "$FAKE/td_worker"
  echo available > "$FAKE/rds"; echo false > "$FAKE/multi"; echo 14 > "$FAKE/ret"
  unset FAKE_FAIL FAKE_STUCK FAKE_ACCOUNT FAKE_ROUTE_MODE FAKE_NAT_STATE FAKE_PUBLIC_CODE FAKE_HTTP_DOWN FAKE_WORKER_STUCK FAKE_FLIP AWS_REGION AWS_DEFAULT_REGION
  export FAKE_IMG="$GOOD_IMG"; }
BOOT_IMG="270370109141.dkr.ecr.eu-central-1.amazonaws.com/ziyaratech/backend:bootstrap"
PUB_IMG="public.ecr.aws/docker/library/postgres:17"
pass=0; failn=0
run() { PATH="$TMP/bin:$PATH" ZT_POLL=0 ZT_TIMEOUT_ECS=1 ZT_TIMEOUT_DRAIN=1 ZT_TIMEOUT_RDS=1 ZT_TIMEOUT_CACHE=1 ZT_TIMEOUT_HTTP=1 \
  bash "$SCRIPT" "$@" >"$TMP/out" 2>&1; echo $?; }
check() { # name cond-result
  if eval "$2"; then pass=$((pass+1)); echo "ok   - $1"; else failn=$((failn+1)); echo "FAIL - $1"; sed 's/^/       /' "$TMP/out" | tail -15; fi; }
g() { cat "$FAKE/$1"; }

reset; rc=$(run stop --yes)
check "stop: api/worker 0, autoscaling 0..0, RDS stopped, state saved" \
 "[[ $rc == 0 && \$(g d_api) == 0 && \$(g d_worker) == 0 && \$(g max_api) == 0 && \$(g rds) == stopped ]] && jq -e '.status==\"stopped\" and .api.desired==2 and .api.max==6 and .worker.min==1' $FAKE/ssm >/dev/null"
rc=$(run stop --yes)
check "stop again is idempotent and keeps restore values" "[[ $rc == 0 ]] && jq -e '.api.desired==2' $FAKE/ssm >/dev/null"
rc=$(run start)
check "start: RDS up, services restored to saved desired/min/max, state running" \
 "[[ $rc == 0 && \$(g d_api) == 2 && \$(g d_worker) == 1 && \$(g max_api) == 6 && \$(g min_api) == 2 && \$(g rds) == available ]] && jq -e '.status==\"running\"' $FAKE/ssm >/dev/null"
check "start never registers a task definition" "! grep -q register-task-definition $FAKE/calls.log"
rc=$(run start)
check "start again is idempotent" "[[ $rc == 0 && \$(g d_api) == 2 ]]"

reset; rc=$(run stop --dry-run)
check "dry-run stop changes nothing" "[[ $rc == 0 && \$(g d_api) == 2 && \$(g rds) == available && ! -f $FAKE/ssm ]] && ! grep -qE 'update-service|stop-db|register-scalable|put-parameter' $FAKE/calls.log"

reset; export FAKE_ACCOUNT=111122223333; rc=$(run stop --yes)
check "wrong account refused before any change" "[[ $rc != 0 && \$(g d_api) == 2 ]] && grep -q 'expected 270370109141' $TMP/out"
reset; export AWS_REGION=us-east-1; rc=$(run status)
check "non eu-central-1 region refused" "[[ $rc != 0 ]] && grep -q 'only operates in eu-central-1' $TMP/out"

reset; echo true > "$FAKE/multi"; rc=$(run stop --yes)
check "Multi-AZ RDS is left running and untouched" "[[ $rc == 0 && \$(g rds) == available && \$(g d_api) == 0 ]] && ! grep -qE 'stop-db-instance|modify-db' $FAKE/calls.log && grep -q 'Multi-AZ' $TMP/out"

reset; export FAKE_FAIL="stop-db-instance"; rc=$(run stop --yes); unset FAKE_FAIL
check "RDS stop API failure: exit nonzero, state 'partial' with restore values" "[[ $rc != 0 ]] && jq -e '.status==\"partial\" and .failedDuring==\"stop\" and .api.max==6' $FAKE/ssm >/dev/null"
rc=$(run stop --yes)
check "interrupted stop resumes and completes" "[[ $rc == 0 && \$(g rds) == stopped ]] && jq -e '.status==\"stopped\" and .api.desired==2' $FAKE/ssm >/dev/null"

reset; run stop --yes >/dev/null; export FAKE_IMG="$BOOT_IMG"
rc=$(run start)
check "bootstrap image refused; services stay stopped" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q 'bootstrap' $TMP/out"

reset; run stop --yes >/dev/null; export FAKE_ROUTE_MODE=blackhole; rc=$(run start)
check "blackholed route stops start before RDS/ECS" "[[ $rc != 0 && \$(g rds) == stopped && \$(g d_api) == 0 ]]"

reset; run stop --yes >/dev/null; echo 99 > "$FAKE/td_api"; rc=$(run start)
check "task definition changed while stopped is refused" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q 'ZT_ACCEPT_TASKDEF_CHANGE' $TMP/out"
export ZT_ACCEPT_TASKDEF_CHANGE=1; rc=$(run start); unset ZT_ACCEPT_TASKDEF_CHANGE
check "...accepted explicitly" "[[ $rc == 0 && \$(g d_api) == 2 ]]"

reset; run stop --yes >/dev/null; export FAKE_STUCK=1; rc=$(run start); unset FAKE_STUCK
check "API never steady: start fails loudly, state not 'running'" "[[ $rc != 0 ]] && ! jq -e '.status==\"running\"' $FAKE/ssm >/dev/null"
rc=$(run start)
check "re-run after failure completes" "[[ $rc == 0 ]] && jq -e '.status==\"running\"' $FAKE/ssm >/dev/null"

reset; run stop --yes >/dev/null; export FAKE_HTTP_DOWN=1; rc=$(run start); unset FAKE_HTTP_DOWN
check "health endpoint down fails start" "[[ $rc != 0 ]] && grep -q 'health' $TMP/out"

reset; echo 0 > "$FAKE/d_api"; echo 0 > "$FAKE/d_worker"; echo 0 > "$FAKE/min_api"; echo 0 > "$FAKE/max_api"; echo 0 > "$FAKE/min_worker"; echo 0 > "$FAKE/max_worker"
rc=$(run start)
check "no state + services at 0 -> refuses to guess" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q ZT_API_RESTORE $TMP/out"
export ZT_API_RESTORE=2,2,6 ZT_WORKER_RESTORE=1,1,3; rc=$(run start); unset ZT_API_RESTORE ZT_WORKER_RESTORE
check "...explicit ZT_*_RESTORE override works" "[[ $rc == 0 && \$(g d_api) == 2 && \$(g max_api) == 6 ]]"

reset; rc=$(run status)
check "status is read-only" "[[ $rc == 0 ]] && ! grep -qE 'update-service|stop-db|start-db|register-scalable|put-parameter' $FAKE/calls.log"


# ── audit additions ─────────────────────────────────────────────────────────
reset; run stop --yes >/dev/null; echo '{not json' > "$FAKE/ssm"
rc=$(run start); rc2=$(run stop --yes); run status >/dev/null
check "corrupt state: start+stop refuse without any mutation, status flags it" \
 "[[ $rc != 0 && $rc2 != 0 && \$(g d_api) == 0 && \$(g rds) == stopped ]] && grep -q CORRUPT $TMP/out"
reset; run stop --yes >/dev/null; jq '.status="bogus"' "$FAKE/ssm" > "$FAKE/x" && mv "$FAKE/x" "$FAKE/ssm"
rc=$(run start); check "unknown state status refused" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q corrupt $TMP/out"
reset; run stop --yes >/dev/null; jq '.api.max=-1' "$FAKE/ssm" > "$FAKE/x" && mv "$FAKE/x" "$FAKE/ssm"
rc=$(run start); check "state with invalid numbers refused" "[[ $rc != 0 && \$(g d_api) == 0 ]]"

reset; run stop --yes >/dev/null; echo 3 > "$FAKE/d_api"; echo 3 > "$FAKE/min_api"; echo 8 > "$FAKE/max_api"
rc=$(run stop --yes)
check "stale 'stopped' state but API running: live values win" "[[ $rc == 0 ]] && jq -e '.api.desired==3 and .api.max==8' $FAKE/ssm >/dev/null"

reset; echo 0 > "$FAKE/d_api"; echo 0 > "$FAKE/min_api"; echo 0 > "$FAKE/max_api"
jq -n '{status:"stopping",api:{desired:2,min:2,max:6,taskDef:"x"},worker:{desired:1,min:1,max:3,taskDef:"y"}}' > "$FAKE/ssm"
rc=$(run stop --yes)
check "interrupted stop (API parked, worker live): mixes saved + live correctly" \
 "[[ $rc == 0 && \$(g d_worker) == 0 && \$(g rds) == stopped ]] && jq -e '.api.max==6 and .worker.max==3 and .worker.taskDef!=\"y\"' $FAKE/ssm >/dev/null"

reset; export FAKE_FLIP=1; rc=$(run stop --yes); unset FAKE_FLIP
check "state flipped by another operator mid-stop: abort before RDS" "[[ $rc != 0 && \$(g rds) == available ]] && grep -q 'state changed' $TMP/out"

reset; run stop --yes >/dev/null; echo storage-full > "$FAKE/rds"; rc=$(run start)
check "RDS terminal status: start refuses, ECS untouched" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q 'terminal' $TMP/out"

reset; echo backing-up > "$FAKE/rds"; rc=$(PATH="$TMP/bin:$PATH" ZT_POLL=0 ZT_TIMEOUT_RDS=20 ZT_TIMEOUT_DRAIN=2 ZT_TIMEOUT_ECS=2 bash "$SCRIPT" stop --yes >"$TMP/out" 2>&1; echo $?)
check "backup in progress: waits for 'available' then stops RDS" "[[ $rc == 0 && \$(g rds) == stopped ]]"
reset; echo modifying > "$FAKE/rds"; rc=$(run stop --yes)
check "backup never finishes: nonzero, RDS not stopped, ECS stopped, state 'partial' (never 'stopped')" "[[ $rc != 0 && \$(g d_api) == 0 && \$(g rds) == modifying ]] && jq -e '.status==\"partial\"' $FAKE/ssm >/dev/null"

reset; export FAKE_WORKER_STUCK=1; rc=$(run stop --yes); unset FAKE_WORKER_STUCK
check "worker never drains: fails, RDS NOT stopped, state 'partial'" "[[ $rc != 0 && \$(g rds) == available ]] && jq -e '.status==\"partial\"' $FAKE/ssm >/dev/null"

reset; run stop --yes >/dev/null; export FAKE_FAIL=describe-replication-groups; rc=$(run start); unset FAKE_FAIL
check "Valkey lookup failure: start stops before ECS" "[[ $rc != 0 && \$(g d_api) == 0 ]]"

reset; run stop --yes >/dev/null; rc=$(run start --dry-run)
check "dry-run start changes nothing" "[[ $rc == 0 && \$(g d_api) == 0 && \$(g rds) == stopped ]] && jq -e '.status==\"stopped\"' $FAKE/ssm >/dev/null"

reset; run stop --yes >/dev/null; echo available > "$FAKE/rds"; run status >/dev/null
check "status warns when RDS auto-started while state says stopped" "grep -q 'billing again' $TMP/out"

reset; ZT_ENV=dev rc=$(ZT_ENV=dev run status)
check "unexpected ZT_ENV refused" "[[ $rc != 0 ]] && grep -q 'ZT_ENV' $TMP/out"

reset; mkdir -p "$TMP/lk"
( exec 9>"$TMP/lk/zt-power.lock"; flock -n 9; sleep 8 ) & holder=$!; sleep 1
rc=$(TMPDIR="$TMP/lk" run stop --yes); kill $holder 2>/dev/null; wait $holder 2>/dev/null
check "concurrent invocation refused by lock, nothing changed" "[[ $rc != 0 && \$(g d_api) == 2 ]] && grep -q 'another zt' $TMP/out"

reset; mkdir -p "$TMP/nojq"; for t in bash mktemp date cat rm head tr grep sed wc flock sleep; do ln -sf "$(command -v $t)" "$TMP/nojq/$t"; done
ln -sf "$TMP/bin/aws" "$TMP/nojq/aws"; ln -sf "$TMP/bin/curl" "$TMP/nojq/curl"
rc=$(PATH="$TMP/nojq" "$(command -v bash)" "$SCRIPT" stop --yes >"$TMP/out" 2>&1; echo $?)
check "missing jq: refuses before any AWS call" "[[ $rc != 0 && ! -e $FAKE/calls.log ]] && grep -q 'jq is required' $TMP/out"

reset; export AWS_SECRET_ACCESS_KEY=SECRETCANARY123 AWS_SESSION_TOKEN=TOKENCANARY456
run stop --yes >/dev/null; cat "$TMP/out" > "$TMP/all"; run start >/dev/null; cat "$TMP/out" >> "$TMP/all"; run status >/dev/null; cat "$TMP/out" >> "$TMP/all"
check "no credentials in output, state or call log" "! grep -rqE 'CANARY' $TMP/all $FAKE"
unset AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

reset; run stop --yes >/dev/null; run start >/dev/null; run stop --yes >/dev/null; run start >/dev/null
cp "$FAKE/calls.log" "$TMP/calls.keep"
check "full cycles only ever call whitelisted mutating verbs (no delete/modify/route53/ec2/sg/terraform/register-task-definition)" \
 "! grep -vE ' (describe|get)-|register-scalable-target|update-service|stop-db-instance|start-db-instance|put-parameter|delete-parameter' $TMP/calls.keep | grep -q . && ! grep 'delete-parameter' $TMP/calls.keep | grep -v power-lock | grep -q ."


# ── review round 2 ──────────────────────────────────────────────────────────
reset; run stop --yes >/dev/null; export FAKE_IMG="$GOOD_IMG $PUB_IMG"; rc=$(run start)
check "public.ecr.aws sidecar accepted (private ECR not queried for it) alongside private image" \
 "[[ $rc == 0 ]] && ! grep -q 'repository-name docker' $FAKE/calls.log && grep -q 'public.ecr.aws/v2/docker/library/postgres/manifests/17' $FAKE/curl.log"
reset; run stop --yes >/dev/null; export FAKE_IMG="$GOOD_IMG $PUB_IMG" FAKE_PUBLIC_CODE=404; rc=$(run start)
check "public image missing on public.ecr.aws: refused, services stay stopped" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q 'public.ecr.aws' $TMP/out"
reset; run stop --yes >/dev/null; export FAKE_IMG="111122223333.dkr.ecr.eu-central-1.amazonaws.com/other/app:1"; rc=$(run start)
check "private ECR image from another account refused" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q 'outside account' $TMP/out"
reset; run stop --yes >/dev/null; export FAKE_IMG="270370109141.dkr.ecr.us-east-1.amazonaws.com/ziyaratech/backend:abc"; rc=$(run start)
check "private ECR image from another region refused" "[[ $rc != 0 && \$(g d_api) == 0 ]]"
reset; run stop --yes >/dev/null; export FAKE_IMG="$GOOD_IMG public.ecr.aws/docker/library/postgres:bootstrap"; rc=$(run start)
check "bootstrap tag on a sidecar refused too" "[[ $rc != 0 && \$(g d_api) == 0 ]]"
reset; run stop --yes >/dev/null; export FAKE_IMG="$GOOD_IMG docker.io/library/redis:7"; rc=$(run start)
check "unverifiable registry: warns, does not block" "[[ $rc == 0 ]] && grep -q 'cannot be verified' $TMP/out"

reset; run stop --yes >/dev/null; export FAKE_ROUTE_MODE=main; rc=$(run start)
check "subnet without explicit association uses VPC main route table (accepted)" "[[ $rc == 0 && \$(g d_api) == 2 ]] && grep -q 'association.main' $FAKE/calls.log"
reset; run stop --yes >/dev/null; export FAKE_ROUTE_MODE=mainblackhole; rc=$(run start)
check "main route table blackhole refused" "[[ $rc != 0 && \$(g d_api) == 0 && \$(g rds) == stopped ]]"
reset; run stop --yes >/dev/null; export FAKE_ROUTE_MODE=nomain; rc=$(run start)
check "no explicit and no main route table: refused" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q 'no explicit or main' $TMP/out"
reset; run stop --yes >/dev/null; export FAKE_ROUTE_MODE=nodefault; rc=$(run start)
check "no default route refused" "[[ $rc != 0 && \$(g d_api) == 0 ]] && grep -q 'no default route' $TMP/out"
reset; run stop --yes >/dev/null; export FAKE_NAT_STATE=failed; rc=$(run start)
check "NAT not available refused" "[[ $rc != 0 && \$(g d_api) == 0 ]]"
reset; run stop --yes >/dev/null; export FAKE_ROUTE_MODE=igw; rc=$(run start)
check "non-NAT active default route (igw) is not falsely rejected, but warned" "[[ $rc == 0 ]] && grep -q 'not a NAT gateway' $TMP/out"

reset; echo modifying > "$FAKE/rds"; rc=$(run stop --yes)
check "RDS never 'available': state is partial, never stopped; ECS stays stopped" "[[ $rc != 0 ]] && jq -e '.status==\"partial\" and .api.desired==2 and .worker.desired==1' $FAKE/ssm >/dev/null"
echo available > "$FAKE/rds"; rc=$(run stop --yes)
check "re-run after RDS partial resumes with the ORIGINAL restore values and ends 'stopped'" "[[ $rc == 0 && \$(g rds) == stopped ]] && jq -e '.status==\"stopped\" and .rds==\"stopped\" and .api.desired==2 and .api.max==6 and .worker.max==3' $FAKE/ssm >/dev/null"
reset; echo true > "$FAKE/multi"; run stop --yes >/dev/null
check "Multi-AZ: recorded explicitly as left running" "jq -e '.status==\"stopped\" and .rds==\"left-running-multi-az\"' $FAKE/ssm >/dev/null"

reset; run stop --yes >/dev/null; export FAKE_STUCK=1; run start >/dev/null; unset FAKE_STUCK
check "failed start leaves 'partial' (failedDuring=start) with the snapshot intact" "jq -e '.status==\"partial\" and .failedDuring==\"start\" and .api.desired==2 and .api.max==6' $FAKE/ssm >/dev/null"
reset; run stop --yes >/dev/null; export FAKE_STUCK=1; run start >/dev/null; unset FAKE_STUCK
rc=$(run stop --yes)
check "stop after a failed start (services parked/half-started) keeps the original snapshot" "[[ $rc == 0 ]] && jq -e '.status==\"stopped\" and .api.desired==2 and .api.min==2 and .api.max==6 and .worker.max==3' $FAKE/ssm >/dev/null"
reset; for i in 1 2 3; do run stop --yes >/dev/null; run start >/dev/null; done; run stop --yes >/dev/null
check "three stop/start cycles: snapshot never degrades to zero" "jq -e '.api.desired==2 and .api.max==6 and .worker.desired==1' $FAKE/ssm >/dev/null && [[ \$(g rds) == stopped ]]"
reset; export FAKE_FLIP=1; rc=$(run stop --yes); unset FAKE_FLIP
check "concurrent state flip: this run's exit does NOT overwrite the other run's state with 'partial'" "[[ $rc != 0 ]] && jq -e '.status==\"starting\"' $FAKE/ssm >/dev/null"

reset; echo '{"cmd":"start","owner":"someone@other-cloudshell","token":"x"}' > "$FAKE/lock"
rc=$(run stop --yes)
check "SSM lock held by another session: stop refused, nothing changed, lock untouched" "[[ $rc != 0 && \$(g d_api) == 2 && \$(g rds) == available && -f $FAKE/lock ]] && grep -q 'holds the lock' $TMP/out"
rc=$(run start)
check "SSM lock blocks start as well" "[[ $rc != 0 ]]"
reset; run stop --yes >/dev/null; run start >/dev/null
check "lock is released after successful runs" "[[ ! -f $FAKE/lock ]]"
reset; export FAKE_FAIL=stop-db-instance; run stop --yes >/dev/null; unset FAKE_FAIL
check "lock is released after a failed run too" "[[ ! -f $FAKE/lock ]]"
reset; echo '{"token":"x"}' > "$FAKE/lock"; rc=$(run stop --dry-run)
check "dry-run with a held lock only warns and never writes/deletes the lock" "[[ $rc == 0 && -f $FAKE/lock ]] && grep -q 'would be refused' $TMP/out"
reset; echo '{"token":"x"}' > "$FAKE/lock"; rc=$(run unlock); rc2=$(run unlock --yes)
check "unlock needs --yes, then removes only the lock parameter" "[[ $rc != 0 && $rc2 == 0 && ! -f $FAKE/lock ]]"

reset; run stop --dry-run >/dev/null; cp "$FAKE/calls.log" "$TMP/dry1"; run stop --yes >/dev/null; : > "$FAKE/calls.log"; run start --dry-run >/dev/null; cp "$FAKE/calls.log" "$TMP/dry2"
check "dry-run (stop and start) performs ZERO mutating AWS calls" "! cat $TMP/dry1 $TMP/dry2 | grep -qE 'register-scalable|update-service|stop-db|start-db|put-parameter|delete-parameter'"
check "dry-run states what it skipped" "grep -q 'NOT checked in dry-run' $TMP/out && grep -q 'NO AWS mutation' $TMP/out"

reset; export HOME="$TMP/home"; mkdir -p "$HOME"
PATH="$TMP/bin:$PATH" bash "$SCRIPT" install >"$TMP/out" 2>&1; rc=$?
check "install creates 3 executable wrappers and prints PATH instructions when ~/bin is missing from PATH" \
 "[[ $rc == 0 && -x $HOME/bin/zt-start && -x $HOME/bin/zt-stop && -x $HOME/bin/zt-status ]] && grep -q 'NOT on PATH' $TMP/out && grep -q 'bashrc' $TMP/out"
rc=$(PATH="$HOME/bin:$TMP/bin:$PATH" ZT_POLL=0 zt-status >"$TMP/out" 2>&1; echo $?)
check "installed zt-status wrapper runs the script" "[[ $rc == 0 ]] && grep -q 'power state' $TMP/out"
rc=$(PATH="$HOME/bin:$TMP/bin:$PATH" ZT_POLL=0 zt-stop --dry-run >"$TMP/out" 2>&1; echo $?)
check "wrapper forwards options (zt-stop --dry-run)" "[[ $rc == 0 ]] && grep -q 'NO AWS mutation' $TMP/out"
PATH="$HOME/bin:$TMP/bin:$PATH" bash "$SCRIPT" install >"$TMP/out" 2>&1
check "install is idempotent and says so when ~/bin is on PATH" "grep -q 'already on PATH' $TMP/out"

echo; echo "passed $pass, failed $failn"; [[ $failn -eq 0 ]]

#!/usr/bin/env bash
# Offline test for infra/scripts/verify-deployed-image.sh — a fake `aws` answers from
# scenario variables, so it needs no AWS account. Run:  bash infra/scripts/tests/verify-deployed-image.test.sh
# CI: executed by .github/workflows/terraform.yml (static job) so the gate itself cannot rot.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../verify-deployed-image.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ACCT=111122223333; REG=eu-central-1
TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
D1="sha256:$(printf '1%.0s' {1..64})"
D2="sha256:$(printf '2%.0s' {1..64})"
GOOD_IMG="$ACCT.dkr.ecr.$REG.amazonaws.com/ziyaratech/backend:$TAG"
OLD_IMG="$ACCT.dkr.ecr.$REG.amazonaws.com/ziyaratech/backend:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

# Fake aws: behaviour is driven by FAKE_* variables.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/aws" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"sts get-caller-identity"*) echo "$FAKE_ACCOUNT" ;;
  *"ecr describe-images"*)     echo "$FAKE_ECR_DIGEST" ;;
  *"ecs describe-services"*"deployments"*)
      if [[ "$args" == *"-api"* ]]; then printf '%b' "$FAKE_API_DEPLOYMENTS"; else printf '%b' "$FAKE_WORKER_DEPLOYMENTS"; fi ;;
  *"ecs describe-services"*"desiredCount"*)
      if [[ "$args" == *"-api"* ]]; then echo "$FAKE_API_COUNTS"; else echo "$FAKE_WORKER_COUNTS"; fi ;;
  *"ecs describe-services"*"taskDefinition"*)
      if [[ "$args" == *"-api"* ]]; then echo "arn:aws:ecs:r:a:task-definition/zt-production-api:9"; else echo "arn:aws:ecs:r:a:task-definition/zt-production-worker:9"; fi ;;
  *"ecs describe-task-definition"*)
      if [[ "$args" == *"-api:"* ]]; then echo "$FAKE_API_IMAGE"; else echo "$FAKE_WORKER_IMAGE"; fi ;;
  *) echo "fake aws: unhandled: $args" >&2; exit 99 ;;
esac
EOF
chmod +x "$TMP/bin/aws"

pass=0; failn=0
run() { # name expect(0|1) [expected-digest]
  local name="$1" want="$2" digest="${3-}"
  out="$(PATH="$TMP/bin:$PATH" AWS_REGION=$REG bash "$SCRIPT" production "$TAG" $digest 2>&1)"; rc=$?
  local got=0; [ $rc -ne 0 ] && got=1
  # A scenario the fake aws cannot answer would also exit non-zero and look like a correct failure.
  if [[ "$out" == *unhandled* ]]; then failn=$((failn+1)); echo "FAIL - $name: fake aws gap"; return; fi
  local last; last="$(tail -n 1 <<<"$out")"
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   - $name  [${last:0:110}]"
  else failn=$((failn+1)); echo "FAIL - $name (exit $rc)"; echo "$out" | sed 's/^/       /'; fi
}
reset() {
  export FAKE_ACCOUNT=$ACCT FAKE_ECR_DIGEST=$D1
  export FAKE_API_DEPLOYMENTS='PRIMARY\tCOMPLETED\n' FAKE_WORKER_DEPLOYMENTS='PRIMARY\tCOMPLETED\n'
  export FAKE_API_COUNTS=$'2\t2' FAKE_WORKER_COUNTS=$'1\t1'
  export FAKE_API_IMAGE=$GOOD_IMG FAKE_WORKER_IMAGE=$GOOD_IMG
}

reset; run "both services run the deployed tag, digest matches"                0 "$D1"
reset; run "no expected digest (rollback): tag checks only"                    0
reset; export FAKE_ECR_DIGEST=$D2;       run "ECR tag digest differs from the pushed digest"      1 "$D1"
reset; export FAKE_API_IMAGE=$OLD_IMG;   run "API still runs a previous image (silent rollback)"  1 "$D1"
reset; export FAKE_WORKER_IMAGE=$OLD_IMG; run "worker still runs a previous image"                1 "$D1"
reset; export FAKE_API_DEPLOYMENTS='PRIMARY\tCOMPLETED\nACTIVE\tCOMPLETED\n'; run "API has a second (old) deployment still draining" 1 "$D1"
reset; export FAKE_WORKER_DEPLOYMENTS='PRIMARY\tFAILED\n';                    run "worker deployment FAILED"          1 "$D1"
reset; export FAKE_API_COUNTS=$'2\t1';   run "API running 1/2"                                    1 "$D1"
reset; export FAKE_WORKER_COUNTS=$'1\t0'; run "worker running 0/1"                                1 "$D1"
reset; export FAKE_ECR_DIGEST=None;      run "tag missing from ECR"                               1 "$D1"
reset; export FAKE_API_IMAGE="$ACCT.dkr.ecr.$REG.amazonaws.com/ziyaratech/backend:latest"; run "a mutable tag is rejected" 1 "$D1"

echo; echo "passed=$pass failed=$failn"
[ "$failn" -eq 0 ]

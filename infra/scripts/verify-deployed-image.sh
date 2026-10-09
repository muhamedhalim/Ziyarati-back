#!/usr/bin/env bash
# Prove that ECS is running the image this deployment shipped.
#
#   verify-deployed-image.sh <staging|production> <image-tag> [expected-digest]
#
# Checks, for BOTH services (api, worker):
#   1. the service has exactly one deployment, PRIMARY and COMPLETED (a rolled-back
#      deployment leaves the previous one primary or a FAILED one behind);
#   2. runningCount == desiredCount;
#   3. the task definition the service points at uses EXACTLY
#      <account>.dkr.ecr.<region>.amazonaws.com/ziyaratech/backend:<tag>;
# and for the tag in ECR:
#   4. the tag resolves to <expected-digest> (when given — the digest the workflow
#      pushed). ECR tags are IMMUTABLE, so tag → digest cannot change afterwards;
#      this ties "the image CI built" to "the image ECS pulls".
#
# Needs only ecs:DescribeServices / DescribeTaskDefinition and ecr:DescribeImages,
# all of which the deploy role already has (no ecs:ListTasks is required).
# Credentials: the zt-<env>-github-deploy role.
set -euo pipefail

ENV="${1:?environment (staging|production)}"
TAG="${2:?image tag}"
EXPECTED_DIGEST="${3:-}"

CLUSTER="zt-${ENV}"
REGION="${AWS_REGION:?AWS_REGION must be set}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
WANT_IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/ziyaratech/backend:${TAG}"

log()  { printf '[verify %s] %s\n' "$ENV" "$*"; }
fail() { log "FAIL: $*"; exit 1; }

ECR_DIGEST="$(aws ecr describe-images --repository-name ziyaratech/backend --image-ids imageTag="$TAG" \
  --query 'imageDetails[0].imageDigest' --output text)"
[[ "$ECR_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "tag ${TAG} not found in ECR"
if [[ -n "$EXPECTED_DIGEST" && "$ECR_DIGEST" != "$EXPECTED_DIGEST" ]]; then
  fail "ECR tag ${TAG} is ${ECR_DIGEST} but this run pushed ${EXPECTED_DIGEST}"
fi

for SVC in api worker; do
  NAME="${CLUSTER}-${SVC}"

  DEPLOYMENTS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$NAME" \
    --query 'services[0].deployments[].[status,rolloutState]' --output text)"
  [[ "$(wc -l <<<"$DEPLOYMENTS" | tr -d ' ')" == "1" ]] || fail "${NAME} has more than one deployment (${DEPLOYMENTS//$'\t'/:})"
  [[ "$DEPLOYMENTS" == $'PRIMARY\tCOMPLETED' ]] || fail "${NAME} deployment is ${DEPLOYMENTS//$'\t'/ }, not PRIMARY COMPLETED"

  COUNTS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$NAME" \
    --query 'services[0].[desiredCount,runningCount]' --output text)"
  read -r DESIRED RUNNING <<<"$COUNTS"
  [[ "$DESIRED" =~ ^[0-9]+$ && "$DESIRED" -ge 1 && "$RUNNING" == "$DESIRED" ]] \
    || fail "${NAME} running ${RUNNING}/${DESIRED}"

  TD="$(aws ecs describe-services --cluster "$CLUSTER" --services "$NAME" \
    --query 'services[0].taskDefinition' --output text)"
  IMAGES="$(aws ecs describe-task-definition --task-definition "$TD" \
    --query 'taskDefinition.containerDefinitions[].image' --output text)"
  for IMG in $IMAGES; do
    [[ "$IMG" == "$WANT_IMAGE" ]] || fail "${NAME} (${TD##*/}) runs ${IMG}, expected ${WANT_IMAGE}"
  done
  log "${NAME}: ${TD##*/} runs ${TAG}, ${RUNNING}/${DESIRED} running, deployment COMPLETED"
done

log "verified: ECS runs ${WANT_IMAGE} (digest ${ECR_DIGEST})"

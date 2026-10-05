#!/usr/bin/env bash
# Deploy one image tag to one environment (infra/docs/DEPLOYMENT.md §1–2).
#
#   ecs-deploy.sh <staging|production> <image-tag> <api-base-url>
#
# 1. For each family (migrate, api, worker): take the LATEST ACTIVE revision —
#    i.e. whatever Terraform last registered — replace ONLY the image, register.
# 2. Run the migrate task once and require exit code 0 (schema first; every
#    migration must be backward-compatible with the previous image).
# 3. Point both services at their new revisions; wait for steady state (the
#    ECS deployment circuit breaker rolls back automatically on failure).
# 4. Smoke-test liveness + readiness through the public ALB.
#
# Needs: aws cli v2, jq, curl. Credentials: the zt-<env>-github-deploy role.
set -euo pipefail

ENV="${1:?environment (staging|production)}"
TAG="${2:?image tag}"
API_URL="${3:?api base url, e.g. https://api.ziyaratech.com}"

CLUSTER="zt-${ENV}"
REGION="${AWS_REGION:?AWS_REGION must be set}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/ziyaratech/backend:${TAG}"

log() { printf '[deploy %s] %s\n' "$ENV" "$*"; }

# Confirm the image exists before touching anything.
aws ecr describe-images --repository-name ziyaratech/backend --image-ids imageTag="$TAG" \
  --query 'imageDetails[0].imageDigest' --output text >/dev/null
log "image ${IMAGE}"

# ── Image vulnerability gate ────────────────────────────────────────────────
# ECR scans on push (basic scanning). Block a NEW image with CRITICAL findings.
# Never block a ROLLBACK to an already-deployed tag: IMAGE_SCAN_GATE=skip is set
# by the workflow when an existing image_tag is redeployed; "warn" reports only.
GATE="${IMAGE_SCAN_GATE:-enforce}"
if [[ "$GATE" != "skip" ]]; then
  if aws ecr wait image-scan-complete --repository-name ziyaratech/backend \
      --image-id imageTag="$TAG" 2>/dev/null; then
    CRIT="$(aws ecr describe-image-scan-findings --repository-name ziyaratech/backend \
      --image-id imageTag="$TAG" \
      --query 'imageScanFindings.findingSeverityCounts.CRITICAL' --output text)"
    if [[ "$CRIT" =~ ^[0-9]+$ && "$CRIT" -gt 0 ]]; then
      log "image has ${CRIT} CRITICAL vulnerabilities (aws ecr describe-image-scan-findings ... imageTag=${TAG})"
      [[ "$GATE" == "enforce" ]] && exit 1
    else
      log "image scan: no CRITICAL findings"
    fi
  else
    log "image scan did not complete in time — gate could not be evaluated"
    [[ "$GATE" == "enforce" ]] && exit 1
  fi
fi

register_with_image() {
  local family="$1"
  aws ecs describe-task-definition --task-definition "$family" --include TAGS --output json \
    | jq --arg IMAGE "$IMAGE" '
        .tags as $tags
        | .taskDefinition
        | .containerDefinitions |= map(.image = $IMAGE)
        | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
              .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
        | if ($tags | length) > 0 then .tags = $tags else . end' \
    > "/tmp/${family}.json"
  aws ecs register-task-definition --cli-input-json "file:///tmp/${family}.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

MIGRATE_TD="$(register_with_image "${CLUSTER}-migrate")"
API_TD="$(register_with_image "${CLUSTER}-api")"
WORKER_TD="$(register_with_image "${CLUSTER}-worker")"
log "registered: ${MIGRATE_TD##*/} ${API_TD##*/} ${WORKER_TD##*/}"

# ── Migrations (one-off task in the worker's private network) ───────────────
NETWORK="$(aws ecs describe-services --cluster "$CLUSTER" --services "${CLUSTER}-worker" \
  --query 'services[0].networkConfiguration' --output json)"

TASK_ARN="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_TD" \
  --launch-type FARGATE --network-configuration "$NETWORK" --started-by "ci-migrate-${TAG:0:20}" \
  --query 'tasks[0].taskArn' --output text)"
log "migrate task ${TASK_ARN##*/} started"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [[ "$EXIT_CODE" != "0" ]]; then
  REASON="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
    --query 'tasks[0].[stoppedReason, containers[0].reason]' --output text)"
  log "MIGRATION FAILED (exit ${EXIT_CODE}): ${REASON}"
  log "logs: aws logs tail /ziyaratech/${ENV}/migrate --since 30m"
  exit 1
fi
log "migrations applied"

# ── Roll services ───────────────────────────────────────────────────────────
aws ecs update-service --cluster "$CLUSTER" --service "${CLUSTER}-api" \
  --task-definition "$API_TD" --query 'service.serviceName' --output text >/dev/null
aws ecs update-service --cluster "$CLUSTER" --service "${CLUSTER}-worker" \
  --task-definition "$WORKER_TD" --query 'service.serviceName' --output text >/dev/null
log "waiting for services to stabilize (circuit breaker rolls back on failure)"
aws ecs wait services-stable --cluster "$CLUSTER" --services "${CLUSTER}-api" "${CLUSTER}-worker"

# A rolled-back deployment also ends "stable" — check which revision won.
RUNNING_TD="$(aws ecs describe-services --cluster "$CLUSTER" --services "${CLUSTER}-api" \
  --query 'services[0].taskDefinition' --output text)"
if [[ "$RUNNING_TD" != "$API_TD" ]]; then
  log "DEPLOYMENT ROLLED BACK: api is running ${RUNNING_TD##*/}, expected ${API_TD##*/}"
  exit 1
fi

# Same check for the worker: its circuit breaker also rolls back silently, and a
# worker stuck on the old revision means new job code is not running.
RUNNING_WTD="$(aws ecs describe-services --cluster "$CLUSTER" --services "${CLUSTER}-worker" \
  --query 'services[0].taskDefinition' --output text)"
if [[ "$RUNNING_WTD" != "$WORKER_TD" ]]; then
  log "DEPLOYMENT ROLLED BACK: worker is running ${RUNNING_WTD##*/}, expected ${WORKER_TD##*/}"
  exit 1
fi

# ── Smoke test through the public entry point ───────────────────────────────
curl -fsS --retry 5 --retry-delay 5 "${API_URL}/api/v1/health" >/dev/null
READY="$(curl -fsS --retry 5 --retry-delay 5 "${API_URL}/api/v1/system/health/readiness")"
STATUS="$(jq -r '.status // .data.status // empty' <<<"$READY")"
if [[ "$STATUS" != "ok" && "$STATUS" != "busy" ]]; then
  log "readiness not ok: ${READY}"
  exit 1
fi
log "deployed ${TAG} — readiness ${STATUS}"

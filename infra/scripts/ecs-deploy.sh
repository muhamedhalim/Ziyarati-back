#!/usr/bin/env bash
# Deploy one image tag to one environment (infra/docs/DEPLOYMENT.md §1–2).
#
#   ecs-deploy.sh <staging|production> <image-tag> <api-base-url>
#
# 1. For each family (migrate, api, worker): take the LATEST ACTIVE revision —
#    i.e. whatever Terraform last registered — replace ONLY the image, register.
# 2. Run the migrate task once and require exit code 0 (schema first; every
#    migration must be backward-compatible with the previous image).
# 3. Point both services at their new revisions; wait (wait-ecs-rollout.sh, bounded) until THOSE
#    revisions are PRIMARY + COMPLETED (the ECS deployment circuit breaker rolls back automatically
#    on failure and the wait reports it).
# 4. verify-deployed-image.sh: both services run exactly this tag (single COMPLETED
#    deployment, all tasks up, ECR digest == the digest CI pushed).
# 5. Smoke-test liveness + readiness through the public ALB.
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

# Confirm the image exists before touching anything, and pin everything below to its DIGEST.
IMAGE_DIGEST="$(aws ecr describe-images --repository-name ziyaratech/backend --image-ids imageTag="$TAG"   --query 'imageDetails[0].imageDigest' --output text)"
if ! [[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  log "image tag ${TAG} not found in ECR (got '${IMAGE_DIGEST}')"
  exit 1
fi
if [[ -n "${EXPECTED_IMAGE_DIGEST:-}" && "$IMAGE_DIGEST" != "$EXPECTED_IMAGE_DIGEST" ]]; then
  log "ECR tag ${TAG} is ${IMAGE_DIGEST} but this run pushed ${EXPECTED_IMAGE_DIGEST} - refusing to deploy"
  exit 1
fi
log "image ${IMAGE} (${IMAGE_DIGEST})"

# -- Image vulnerability gate ------------------------------------------------
# ECR scans on push, asynchronously. ecr-scan-gate.sh polls the scan of THIS digest with a
# bounded deadline, distinguishes IN_PROGRESS / COMPLETE / FAILED / UNSUPPORTED / API errors, and
# only evaluates CRITICAL findings once the scan is COMPLETE. IMAGE_SCAN_GATE:
#   enforce (default) - CRITICAL findings, or a scan that cannot be evaluated, block the deploy
#   warn              - the same conditions are reported but do not block
#   skip              - set by the workflow when an existing image_tag is redeployed (rollback)
bash "$(dirname "$0")/ecr-scan-gate.sh" "$IMAGE_DIGEST" "${IMAGE_SCAN_GATE:-enforce}"

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
log "waiting for the rollout of ${API_TD##*/} / ${WORKER_TD##*/} (circuit breaker rolls back on failure)"
# NOT `aws ecs wait services-stable`: that waiter ignores rolloutState and the task definition, so it
# can return while the new deployment is still IN_PROGRESS or after a rollback. wait-ecs-rollout.sh
# polls (bounded by ROLLOUT_TIMEOUT_SECONDS) until THESE task definitions are PRIMARY + COMPLETED and
# exits 10/11/12/13 for failed-or-rolled-back / superseded / timeout / AWS errors.
if ! bash "$(dirname "$0")/wait-ecs-rollout.sh" "$CLUSTER" "${CLUSTER}-api=${API_TD}" "${CLUSTER}-worker=${WORKER_TD}"; then
  log "ROLLOUT NOT COMPLETE - see the [rollout] lines above (events, deployment states)."
  exit 1
fi

# Independent re-check (cheap, one read each): the revision that won must be the one we registered.
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

# ── Prove ECS runs the image this run shipped (tag, completed rollout, digest) ──
# EXPECTED_IMAGE_DIGEST is exported by the workflow after the push; empty on a rollback.
bash "$(dirname "$0")/verify-deployed-image.sh" "$ENV" "$TAG" "${EXPECTED_IMAGE_DIGEST:-}"

# ── Smoke test through the public entry point ───────────────────────────────
curl -fsS --retry 5 --retry-delay 5 "${API_URL}/api/v1/health" >/dev/null
READY="$(curl -fsS --retry 5 --retry-delay 5 "${API_URL}/api/v1/system/health/readiness")"
STATUS="$(jq -r '.status // .data.status // empty' <<<"$READY")"
if [[ "$STATUS" != "ok" && "$STATUS" != "busy" ]]; then
  log "readiness not ok: ${READY}"
  exit 1
fi
log "deployed ${TAG} — readiness ${STATUS}"

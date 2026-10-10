#!/usr/bin/env bash
# ECR image vulnerability gate: wait (bounded) for the image scan, then enforce the CRITICAL policy.
#
#   ecr-scan-gate.sh <image-id> [enforce|warn|skip]
#
#   <image-id>  an image DIGEST (sha256:…, preferred: scans exactly the bytes being deployed) or a tag.
#   enforce     (default) CRITICAL findings, a failed/unsupported scan, an API error or a timeout all fail.
#   warn        the same conditions are logged as warnings and the script exits 0.
#   skip        the gate is not evaluated (used for rollbacks to an already-deployed tag).
#
# Why this exists: ECR scans ASYNCHRONOUSLY after push. The previous inline gate used
# `aws ecr wait image-scan-complete 2>/dev/null` and reported EVERY non-zero exit as
# "did not complete in time" — a FAILED scan, an unsupported image, a missing IAM grant and a
# real timeout were indistinguishable, and a scan that just started was not retried sensibly.
#
# Statuses (imageScanStatus.status) and what is done with each:
#   IN_PROGRESS, PENDING                       scan running → keep polling until the deadline
#   COMPLETE (basic) / ACTIVE (enhanced)       findings are authoritative → evaluate CRITICAL count
#   FAILED                                     terminal; reported with ECR's own description
#   UNSUPPORTED_IMAGE                          terminal; ECR cannot scan this image (OS / manifest type)
#   FINDINGS_UNAVAILABLE, SCAN_ELIGIBILITY_EXPIRED   terminal; no usable findings
# API errors:
#   ScanNotFoundException                      scan not registered yet right after push → retry (bounded)
#   Throttling / 5xx / network                 transient → retry with backoff (bounded consecutive errors)
#   AccessDenied, ImageNotFound, RepositoryNotFound, InvalidParameter, anything else   terminal, reported verbatim
#
# Tunables (env): ECR_REPOSITORY (ziyaratech/backend), ECR_SCAN_TIMEOUT_SECONDS (900),
#   ECR_SCAN_POLL_INTERVAL (10), ECR_SCAN_MAX_CONSECUTIVE_ERRORS (6), ECR_SCAN_MAX_INTERVAL (60).
# Needs: aws cli v2 and ecr:DescribeImageScanFindings. No jq.
set -uo pipefail

IMAGE_ID="${1:?image digest (sha256:…) or tag}"
GATE="${2:-enforce}"

REPO="${ECR_REPOSITORY:-ziyaratech/backend}"
TIMEOUT="${ECR_SCAN_TIMEOUT_SECONDS:-900}"
INTERVAL="${ECR_SCAN_POLL_INTERVAL:-10}"
MAX_ERRORS="${ECR_SCAN_MAX_CONSECUTIVE_ERRORS:-6}"
MAX_INTERVAL="${ECR_SCAN_MAX_INTERVAL:-60}"

log() { printf '[scan] %s\n' "$*"; }

case "$GATE" in enforce | warn | skip) ;; *) log "unknown gate mode '${GATE}' (enforce|warn|skip)"; exit 2 ;; esac

if [[ "$GATE" == "skip" ]]; then
  log "gate=skip — vulnerability gate not evaluated (rollback to an already-deployed image)"
  exit 0
fi

if [[ "$IMAGE_ID" == sha256:* ]]; then
  SELECTOR="imageDigest=${IMAGE_ID}"
else
  SELECTOR="imageTag=${IMAGE_ID}"
fi

# Not evaluable (as opposed to "has CRITICAL findings"): enforce fails closed, warn continues.
not_evaluable() {
  if [[ "$GATE" == "enforce" ]]; then
    log "FAIL: $* — gate=enforce, refusing to deploy an image whose scan could not be evaluated."
    log "      Re-run the workflow once the scan is healthy (an existing image is reused, not re-pushed)."
    exit 1
  fi
  log "WARNING: $* — gate=warn, continuing WITHOUT a vulnerability verdict."
  exit 0
}

START="$(date +%s)"
DELAY="$INTERVAL"
ERRORS=0
ATTEMPT=0

while :; do
  ATTEMPT=$((ATTEMPT + 1))
  ERR_FILE="$(mktemp)"
  OUT="$(aws ecr describe-image-scan-findings --repository-name "$REPO" --image-id "$SELECTOR" \
    --max-results 1 \
    --query '[imageScanStatus.status, imageScanFindings.findingSeverityCounts.CRITICAL, imageScanStatus.description]' \
    --output text 2>"$ERR_FILE")"
  RC=$?
  ERR="$(cat "$ERR_FILE")"
  rm -f "$ERR_FILE"

  STATUS=""; CRIT=""; DESC=""
  TRANSIENT=0
  if [[ $RC -eq 0 ]]; then
    ERRORS=0
    IFS=$'\t' read -r STATUS CRIT DESC <<<"$OUT"
    case "$STATUS" in
      COMPLETE | ACTIVE)
        if [[ "$CRIT" =~ ^[0-9]+$ ]]; then
          if [[ "$CRIT" -gt 0 ]]; then
            log "image has ${CRIT} CRITICAL vulnerabilities (aws ecr describe-image-scan-findings --repository-name ${REPO} --image-id ${SELECTOR})"
            if [[ "$GATE" == "enforce" ]]; then
              log "FAIL: CRITICAL findings block this deploy (set ALLOW_CRITICAL_IMAGE_FINDINGS=true only as a conscious, recorded exception)."
              exit 1
            fi
            log "WARNING: gate=warn — deploying despite ${CRIT} CRITICAL findings."
            exit 0
          fi
        elif [[ "$CRIT" != "None" ]]; then
          # COMPLETE must carry a numeric count or none at all (zero findings omit the key). Anything else is unreadable.
          not_evaluable "scan COMPLETE but the CRITICAL count is unreadable ('${CRIT}')"
        fi
        log "image scan COMPLETE: no CRITICAL findings (after ${ATTEMPT} poll(s), $(($(date +%s) - START))s)"
        exit 0
        ;;
      IN_PROGRESS | PENDING)
        log "scan ${STATUS} (poll ${ATTEMPT}, $(($(date +%s) - START))s elapsed)"
        ;;
      FAILED)
        not_evaluable "ECR image scan FAILED: ${DESC:-no description}"
        ;;
      UNSUPPORTED_IMAGE)
        not_evaluable "ECR cannot scan this image (UNSUPPORTED_IMAGE): ${DESC:-no description}"
        ;;
      FINDINGS_UNAVAILABLE | SCAN_ELIGIBILITY_EXPIRED)
        not_evaluable "ECR scan result unusable (${STATUS}): ${DESC:-no description}"
        ;;
      *)
        not_evaluable "ECR returned an unrecognised scan status '${STATUS}'"
        ;;
    esac
  else
    CODE="$(sed -n 's/.*An error occurred (\([A-Za-z0-9]*\)).*/\1/p' <<<"$ERR" | head -n 1)"
    case "$CODE" in
      ScanNotFoundException)
        # Right after a push the scan record may not exist yet; bounded by the overall deadline.
        log "scan not registered yet (ScanNotFoundException; poll ${ATTEMPT}, $(($(date +%s) - START))s elapsed)"
        ;;
      ThrottlingException | TooManyRequestsException | ServerException | ServiceUnavailableException | RequestTimeout* | InternalFailure | "")
        # "" = no AWS error code: connection reset / DNS / timeout from the CLI itself.
        ERRORS=$((ERRORS + 1))
        TRANSIENT=1
        log "transient error talking to ECR (${CODE:-network}; ${ERRORS}/${MAX_ERRORS}): ${ERR:0:200}"
        if [[ "$ERRORS" -ge "$MAX_ERRORS" ]]; then
          not_evaluable "ECR API unreachable after ${ERRORS} consecutive errors (last: ${CODE:-network})"
        fi
        ;;
      *)
        not_evaluable "ECR API error ${CODE}: ${ERR:0:300}"
        ;;
    esac
  fi

  NOW="$(date +%s)"
  if [[ $((NOW - START)) -ge "$TIMEOUT" ]]; then
    not_evaluable "image scan still ${STATUS:-not available} after ${TIMEOUT}s (${ATTEMPT} polls)"
  fi

  sleep "$DELAY"
  # Back off only on errors; a healthy IN_PROGRESS scan is polled at the base interval.
  if [[ "$TRANSIENT" -eq 1 ]]; then
    DELAY=$((DELAY * 2)); [[ "$DELAY" -gt "$MAX_INTERVAL" ]] && DELAY="$MAX_INTERVAL"
  else
    DELAY="$INTERVAL"
  fi
done

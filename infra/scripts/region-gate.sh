#!/usr/bin/env bash
# Region gate for the data boundary (residency plan §16; WELL-ARCHITECTED / SECURITY.md §6).
#
#   region-gate.sh static            every PR: no region literals in Terraform, tfvars consistent
#   region-gate.sh deploy <env>      before ANY plan or apply: a region MUST be approved
#
# `static` passes while approved_regions is empty (that is the correct state until the
# hosting location is signed off). `deploy` FAILS in that state: nothing may be planned
# or applied against AWS until a region is approved in writing and listed in
# environments/<env>/terraform.tfvars.
#
# Needs only bash + grep + sed. Run from the repository root.
set -uo pipefail

MODE="${1:-}"
ENVIRONMENT="${2:-}"
TF_ROOT="${TF_ROOT:-infra/terraform}"
FAILED=0

fail() { echo "::error::region-gate: $*"; FAILED=1; }
note() { echo "region-gate: $*"; }

REGION_RE='\b(us|eu|ap|me|sa|ca|af|il|mx)(-gov)?-(east|west|central|south|north|southeast|southwest|northeast|northwest)-[0-9]\b'

# ── 1. No region literal in Terraform code ──────────────────────────────────
# Regions come from variables. The ONE documented exception is the Route 53
# health-check alias provider in the environment roots (its metrics exist only in
# us-east-1). Tests and mock data are not deployed code, so they are skipped.
scan_literals() {
  local hits
  hits=$(grep -rnEI "$REGION_RE" "$TF_ROOT" --include='*.tf' \
    --exclude-dir=.terraform --exclude-dir=tests --exclude-dir=testing \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//)' \
    | grep -vE "^${TF_ROOT}/environments/(staging|production)/main\.tf:[0-9]+:[[:space:]]*region[[:space:]]*=[[:space:]]*\"us-east-1\"" \
    || true)
  if [ -n "$hits" ]; then
    fail "region literal(s) in Terraform code — use var.aws_region / approved_regions:"
    echo "$hits"
  else
    note "no region literals in Terraform code"
  fi
}

# ── 1b. No construct that copies data out of the region ─────────────────────
# A Terraform test cannot assert that a resource does NOT exist, so absence is
# checked on the source. Every pattern below is a way to replicate or ship data
# to another region/account/service. The one sanctioned cross-region path — the
# AWS Backup copy_action in modules/backup — is not listed here: it is gated by
# approved_dr_destinations (platform variable validation) and tested instead.
FORBIDDEN_RE='resource[[:space:]]+"(aws_s3_bucket_replication_configuration|aws_db_instance_automated_backups_replication|aws_elasticache_global_replication_group|aws_ecr_replication_configuration|aws_kms_replica_key|aws_kms_replica_external_key|aws_cloudfront_[a-z_]+|aws_bedrock[a-z_]*|aws_dms_[a-z_]+|aws_datasync_[a-z_]+|aws_cloudwatch_log_destination|aws_cloudwatch_log_subscription_filter|aws_s3_bucket_replication)"|replicate_source_db[[:space:]]*=|multi_region[[:space:]]*=[[:space:]]*true|^[[:space:]]*replica[[:space:]]*{'
scan_forbidden() {
  local hits
  hits=$(grep -rnEI "$FORBIDDEN_RE" "$TF_ROOT" --include='*.tf'     --exclude-dir=.terraform --exclude-dir=tests --exclude-dir=testing     | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//)' || true)
  if [ -n "$hits" ]; then
    fail "construct(s) that copy data out of the region (replication, replicas, multi-Region keys, CloudFront, Bedrock, log shipping):"
    echo "$hits"
  else
    note "no replication / data-export constructs in Terraform code"
  fi
}

# ── 2. tfvars parsing (single-line scalars and lists, as the repo writes them) ─
scalar() { # file key
  sed -nE "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" "$1" | head -1
}
list() { # file key → one item per line
  local line
  line=$(grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" | head -1)
  [ -z "$line" ] && return 0
  if ! echo "$line" | grep -q '\]'; then
    fail "$1: '$2' must be written on a single line so the gate can read it"
    return 0
  fi
  echo "$line" | sed -E 's/^[^[]*\[//; s/\].*$//' | tr ',' '\n' | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//' | grep -v '^$' || true
}
in_list() { # needle, then items on stdin
  grep -qxF -- "$1"
}

check_env() { # env, enforce(0|1)
  local env="$1" enforce="$2" vars="$TF_ROOT/environments/$1/terraform.tfvars"
  if [ ! -f "$vars" ]; then fail "$vars not found"; return; fi

  local region dr approved dr_ok
  region=$(scalar "$vars" aws_region)
  dr=$(scalar "$vars" dr_backup_region)
  approved=$(list "$vars" approved_regions)
  dr_ok=$(list "$vars" approved_dr_destinations)

  if [ -z "$approved" ]; then
    if [ "$enforce" = 1 ]; then
      fail "$env: approved_regions is empty — no hosting location is approved. Plan/apply is blocked until the written decision exists and the region is listed."
    else
      note "$env: approved_regions is empty (expected until the hosting location is approved); deploy jobs stay blocked"
    fi
  else
    if [ -z "$region" ]; then
      fail "$env: aws_region missing in $vars"
    elif ! echo "$approved" | in_list "$region"; then
      fail "$env: aws_region '$region' is not in approved_regions"
    fi
  fi

  if [ -n "$dr" ]; then
    if [ "$dr" = "$region" ]; then
      fail "$env: dr_backup_region equals aws_region (no protection against a regional loss)"
    elif ! echo "$dr_ok" | in_list "$dr"; then
      fail "$env: dr_backup_region '$dr' is not in approved_dr_destinations — a backup copy is a transfer of patient data"
    fi
  fi

  # The region the CI credentials point at must be the region being deployed.
  if [ "$enforce" = 1 ] && [ -n "${AWS_REGION:-}" ] && [ -n "$region" ] && [ "$AWS_REGION" != "$region" ]; then
    fail "$env: CI AWS_REGION '$AWS_REGION' differs from aws_region '$region'"
  fi
}

case "$MODE" in
  static)
    scan_literals
    scan_forbidden
    for e in staging production; do check_env "$e" 0; done
    ;;
  deploy)
    case "$ENVIRONMENT" in staging|production) ;; *) echo "usage: $0 deploy <staging|production>"; exit 2 ;; esac
    scan_literals
    scan_forbidden
    check_env "$ENVIRONMENT" 1
    ;;
  *)
    echo "usage: $0 static | deploy <staging|production>"
    exit 2
    ;;
esac

if [ "$FAILED" -ne 0 ]; then
  echo "region-gate: FAILED"
  exit 1
fi
echo "region-gate: OK ($MODE${ENVIRONMENT:+ $ENVIRONMENT})"

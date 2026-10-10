#!/usr/bin/env bash
# Validates the rendered organisation SCPs with IAM Access Analyzer's policy
# validation (policy type SERVICE_CONTROL_POLICY). OPERATOR TOOL — it makes AWS
# API calls and is NOT run by CI or by any test in this repository.
#
# What it catches that the offline tests cannot: an action name or condition key
# that does not exist (a Deny on a misspelt action silently matches nothing, which
# looks like protection and is not). Findings of type ERROR fail the script;
# WARNING / SECURITY_WARNING / SUGGESTION are printed for a human to read.
#
#   SCP_VARS_JSON=vars.json AWS_REGION=<approved region> bash infra/scripts/scp-validate.sh
#
# SCP_VARS_JSON holds the module inputs (see infra/scripts/scp-render.cjs). The
# credentials need only access-analyzer:ValidatePolicy; no resource is read or
# changed. Needs: node, terraform (rendering), aws CLI v2, jq.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SCP_VARS_JSON:?set SCP_VARS_JSON to a JSON file with the module inputs}"
: "${AWS_REGION:?set AWS_REGION to an approved region (the API is regional; the call is stateless)}"
for tool in node terraform aws jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "scp-validate: '$tool' not found" >&2; exit 2; }
done

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

node "$HERE/scp-render.cjs" --vars "$SCP_VARS_JSON" --out "$OUT" || exit 2

FAILED=0
for doc in "$OUT"/*.json; do
  name="$(basename "$doc" .json)"
  chars="$(wc -c < "$doc" | tr -d ' ')"
  echo "── $name ($chars characters; limit 5120)"
  result="$(aws accessanalyzer validate-policy \
    --region "$AWS_REGION" \
    --policy-type SERVICE_CONTROL_POLICY \
    --policy-document "file://$doc" \
    --output json)" || { echo "scp-validate: validate-policy call failed for $name" >&2; FAILED=1; continue; }

  echo "$result" | jq -r '.findings[] | "  [\(.findingType)] \(.issueCode): \(.findingDetails)"'
  errors="$(echo "$result" | jq '[.findings[] | select(.findingType == "ERROR")] | length')"
  if [ "$errors" -gt 0 ]; then
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "scp-validate: FAILED — fix every ERROR before attaching a policy anywhere"
  exit 1
fi
echo "scp-validate: no ERROR findings (read the warnings above)"

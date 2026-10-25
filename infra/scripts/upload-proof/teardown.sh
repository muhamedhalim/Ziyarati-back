#!/usr/bin/env bash
# Deletes EXACTLY what setup.sh recorded in state.env (all names are asserted to carry the proof prefix).
set -euo pipefail
cd "$(dirname "$0")"
[ -f state.env ] || { echo "no state.env - nothing to tear down"; exit 0; }
# shellcheck disable=SC1091
source state.env
case "$BUCKET" in zt-upload-proof-*) ;; *) echo "refusing: bucket '$BUCKET' is not a proof bucket"; exit 1;; esac
case "$ROLE" in zt-upload-proof-*) ;; *) echo "refusing: role '$ROLE' is not a proof role"; exit 1;; esac
case "$ALIAS" in alias/zt-upload-proof-*) ;; *) echo "refusing: alias '$ALIAS'"; exit 1;; esac

# 1) Empty the bucket: every version and delete marker, in batches of <=1000.
while :; do
  BATCH=$(aws s3api list-object-versions --bucket "$BUCKET" --max-items 1000 --output json \
    --query '{Objects: [].{Key:Key,VersionId:VersionId}}' 2>/dev/null || echo '{"Objects":null}')
  COUNT=$(printf '%s' "$BATCH" | python -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("Objects") or []))')
  [ "$COUNT" = "0" ] && break
  printf '%s' "$BATCH" | python -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps({"Objects":d["Objects"],"Quiet":True}))' > .zt-proof-del.json
  aws s3api delete-objects --bucket "$BUCKET" --delete file://.zt-proof-del.json >/dev/null
done
rm -f .zt-proof-del.json
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
# 2) Role.
aws iam delete-role-policy --role-name "$ROLE" --policy-name storage-proof 2>/dev/null || true
aws iam delete-role --role-name "$ROLE" 2>/dev/null || true
# 3) Key: remove the alias, schedule deletion (AWS minimum is 7 days; the key is unusable at once).
aws kms delete-alias --region "$REGION" --alias-name "$ALIAS"
aws kms schedule-key-deletion --region "$REGION" --key-id "$KEY_ID" --pending-window-in-days 7 >/dev/null
rm -f state.env
echo "Torn down. KMS key $KEY_ID is pending deletion (7 days)."

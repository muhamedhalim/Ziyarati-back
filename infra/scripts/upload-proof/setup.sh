#!/usr/bin/env bash
# Creates a THROWAWAY, tagged copy of the production upload storage shape in eu-central-1:
#   SSE-KMS key + alias, private versioned bucket (same deny policy as modules/s3-uploads),
#   and a least-privilege role identical to the API task role's storage policy.
# Writes every created identifier to state.env so teardown.sh deletes exactly these and nothing else.
# Mutates AWS. Run only after explicit approval; see README.md.
set -euo pipefail
cd "$(dirname "$0")"
REGION=eu-central-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text)
ID=$(date +%s | tail -c 7)$RANDOM
BUCKET="zt-upload-proof-${ID}-${ACCOUNT}"
ROLE="zt-upload-proof-${ID}"
[ -f state.env ] && { echo "state.env exists - run teardown.sh first"; exit 1; }
TAGS_KMS='TagKey=zt-purpose,TagValue=upload-proof TagKey=zt-ephemeral,TagValue=true'

KEY_ARN=$(aws kms create-key --region $REGION --description "ZT upload proof ${ID} (throwaway)" --tags $TAGS_KMS --query KeyMetadata.Arn --output text)
KEY_ID=${KEY_ARN##*/}
aws kms create-alias --region $REGION --alias-name "alias/zt-upload-proof-${ID}" --target-key-id "$KEY_ID"
printf 'REGION=%s\nACCOUNT=%s\nBUCKET=%s\nROLE=%s\nKEY_ARN=%s\nKEY_ID=%s\nALIAS=alias/zt-upload-proof-%s\n' "$REGION" "$ACCOUNT" "$BUCKET" "$ROLE" "$KEY_ARN" "$KEY_ID" "$ID" > state.env

aws s3api create-bucket --region $REGION --bucket "$BUCKET" --create-bucket-configuration LocationConstraint=$REGION >/dev/null
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=zt-purpose,Value=upload-proof},{Key=zt-ephemeral,Value=true}]'
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"$KEY_ARN\"},\"BucketKeyEnabled\":true}]}"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
cat > .zt-proof-policy.json <<POL
{"Version":"2012-10-17","Statement":[
{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::$BUCKET/*","arn:aws:s3:::$BUCKET"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}},
{"Sid":"DenyOutsideAccount","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::$BUCKET/*","arn:aws:s3:::$BUCKET"],"Condition":{"StringNotEquals":{"aws:PrincipalAccount":"$ACCOUNT"}}},
{"Sid":"DenyWrongEncryptionKey","Effect":"Deny","Principal":"*","Action":"s3:PutObject","Resource":"arn:aws:s3:::$BUCKET/*","Condition":{"StringNotEqualsIfExists":{"s3:x-amz-server-side-encryption-aws-kms-key-id":"$KEY_ARN"}}}]}
POL
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file://.zt-proof-policy.json

cat > .zt-proof-trust.json <<TR
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"$CALLER_ARN"},"Action":"sts:AssumeRole"}]}
TR
cat > .zt-proof-role-policy.json <<RP
{"Version":"2012-10-17","Statement":[
{"Sid":"UploadsObjects","Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject","s3:DeleteObjectVersion"],"Resource":"arn:aws:s3:::$BUCKET/*"},
{"Sid":"UploadsList","Effect":"Allow","Action":["s3:ListBucket","s3:ListBucketVersions"],"Resource":"arn:aws:s3:::$BUCKET"},
{"Sid":"UploadsKmsViaS3Only","Effect":"Allow","Action":["kms:GenerateDataKey","kms:Decrypt"],"Resource":"$KEY_ARN","Condition":{"StringEquals":{"kms:ViaService":"s3.$REGION.amazonaws.com"}}}]}
RP
aws iam create-role --role-name "$ROLE" --assume-role-policy-document file://.zt-proof-trust.json --max-session-duration 3600 --tags Key=zt-purpose,Value=upload-proof Key=zt-ephemeral,Value=true >/dev/null
aws iam put-role-policy --role-name "$ROLE" --policy-name storage-proof --policy-document file://.zt-proof-role-policy.json
echo "ROLE_ARN=arn:aws:iam::${ACCOUNT}:role/${ROLE}" >> state.env
rm -f .zt-proof-*.json
echo "Created (see state.env):"; cat state.env

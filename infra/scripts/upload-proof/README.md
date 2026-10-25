# Real-AWS upload proof (throwaway)

No staging stack exists, so the upload path is proven against a **disposable, tagged copy** of the
production storage shape (SSE-KMS key + private versioned bucket + least-privilege role), never the
production bucket.

1. `bash setup.sh` — creates the key, bucket and role; writes `state.env`.
2. Assume the role (`aws sts assume-role --role-arn $ROLE_ARN ...`) and export the temporary
   credentials, then run the app suite against it:
   `UPLOAD_PROOF_BUCKET=$BUCKET UPLOAD_PROOF_KMS_KEY_ARN=$KEY_ARN npx jest --config ./test/jest-e2e.json --runInBand test/upload-aws-proof.e2e-spec.ts`
   (needs the usual e2e Postgres/Redis environment; a local database only — nothing touches production data).
3. `bash teardown.sh` — empties and deletes exactly what `state.env` lists. The KMS key enters its
   7-day deletion window (the AWS minimum).

Cost: cents (a few KMS requests, a few MB of S3 for minutes).

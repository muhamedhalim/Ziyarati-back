# Organisation guardrails (SCP) — rollout runbook

Companion to `infra/terraform/modules/org-guardrails` and `infra/terraform/environments/org-guardrails` (residency plan T14, section 15). This file is the procedure; the policies, their tests and the evaluator that proves their behaviour live next to the code.

**State when written (2026-10-10):** the module is written and tested; **nothing has been applied**, and no AWS call has been made for it. Whether an AWS Organization exists is **unknown** (`OV` with the account owner). `approved_regions`, `target_ids` and `audit_exempt_principal_arns` are all empty in `environments/org-guardrails/terraform.tfvars` on purpose, so a plan fails closed.

> This is a technical control. It enforces a region list that someone has approved in writing; it does not decide which regions are lawful (residency plan L1/L2) and it is not a statement of PDPL compliance.

---

## 1. What the three policies do

| Policy | Denies | Does not touch |
|---|---|---|
| `region-boundary` | any API call whose `aws:RequestedRegion` is not approved, except a short list of **global control-plane** services (IAM, STS, Organizations, Route 53, Budgets, billing, Support, Health, Trusted Advisor, read-only CloudFront, `ec2:DescribeRegions`, `s3:ListAllMyBuckets`); in `us-east-1` only, and only when `us_east_1_health_check_exception = true`, everything except the 21 CloudWatch-alarm / SNS actions the Route 53 health-check alarm needs; `account:EnableRegion` for an unapproved opt-in region | the management account; service-linked roles |
| `data-copy-guard` | S3 replication and Batch copy; RDS read replicas, automated-backup replication, snapshot sharing and export; KMS key replication and **multi-region key creation**; Secrets Manager replication; ECR replication; ElastiCache global datastore and snapshot copy/export; CloudWatch log destinations, subscription filters and cross-account observability links; DMS, DataSync, **Bedrock**; CloudFront distribution create/update/copy; **AWS Backup copy into any vault that is not listed** in `approved_backup_vault_arns` | everything the application and the platform do today (asserted by the evaluator test) |
| `audit-guard` | stopping, deleting or re-pointing CloudTrail; deleting or updating GuardDuty detectors and disassociating members; deleting the Access Analyzer; **everyone** leaving the organisation. The first rule exempts the principals in `audit_exempt_principal_arns` | reading anything |

Why some copy APIs are **not** denied by action: a cross-region RDS snapshot copy or read replica is started *from the destination region*, so `region-boundary` already stops it reaching an unapproved region. Denying `rds:CopyDBSnapshot` outright would also break in-region AWS Backup. A copy between two **approved** regions is the one case left open, and it is a deliberate decision (DR scenario, L13): `lifted_data_copy_actions` lifts a single named action, and the change shows up in review.

## 2. What an SCP cannot do (so none of this is claimed)

- **The management account is never restricted.** Keep workloads out of it. Anyone with administrator access there can detach every policy — that is the way back (section 7) and also a risk to review.
- **Service-linked roles are not restricted.** Anything AWS does through a service-linked role bypasses the SCPs.
- **Service-initiated copies have no request region.** That is why replication APIs are denied by action rather than relied on through the region condition.
- **No verified condition key** exists (to our knowledge) for: `secretsmanager:CreateSecret` with replica regions (only `ReplicateSecretToRegions` is denied), SNS subscriptions to an endpoint in another region, EventBridge targets in another region, or sharing a resource by resource-policy. These are covered only by the Terraform source scan in `region-gate.sh` (it refuses `replica {}`, replication resources, log shipping, multi-region keys) and by review. An operator with console access in a member account can still do them. **Residual risk, accepted knowingly or closed by an additional control.**
- **An SCP is not data-plane isolation.** It cannot see where an S3 object's bytes sit, only which API was called in which region.
- **Global services keep working from anywhere**, by design (section 1). IAM, billing and support case text can hold a name; do not put patient data in resource names, tags, descriptions or support cases.

## 3. Preconditions

1. An AWS Organization exists and `SERVICE_CONTROL_POLICY` is enabled at the root. The module refuses to plan otherwise (precondition) and says so.
2. The hosting location is approved **in writing** and listed in `approved_regions`. It must contain every region of every environment (`region-gate.sh` checks this) and, when DR is on, the DR region. `region-gate.sh deploy` also fails while an environment uses a region the SCP list does not have, so the SCP can never be narrower than the stack it governs.
3. The accounts to govern are **member** accounts. Decide the target: a **test OU with a throwaway account first**, production OU second, organisation root last.
4. `audit_exempt_principal_arns` lists the roles that maintain CloudTrail/GuardDuty/Access Analyzer — the account-baseline apply role and a break-glass role. Write them as the **role ARN** `arn:aws:iam::<account>:role/<name>`; `aws:PrincipalARN` for a role session is the role ARN, not the `assumed-role/.../session` ARN (the evaluator test pins this trap). A look-alike name is not exempt (also tested).
5. A state bucket in the management account, in an approved region (`backend.hcl.example`). The state holds policy JSON and ids only.
6. `us_east_1_health_check_exception` is `true` while `enable_external_health_check` is `true` (the platform default) and `us-east-1` is not itself approved. The gate fails the other combination.

## 4. Offline checks (no AWS, any time)

```bash
bash infra/scripts/region-gate.sh static
node --test infra/scripts/tests/scp-semantics.test.cjs
terraform -chdir=infra/terraform/modules/org-guardrails/policies init -backend=false
terraform -chdir=infra/terraform/modules/org-guardrails/policies test
terraform -chdir=infra/terraform/modules/org-guardrails init -backend=false
terraform -chdir=infra/terraform/modules/org-guardrails test
```

`scp-semantics.test.cjs` renders the three documents and evaluates concrete requests against them: an unapproved region, `us-east-1` with and without the exception, each replication API, multi-region key creation, backup copy into an approved and an unapproved vault, a lifted action, the audit exemption (exact ARN, wildcard account, look-alike name, session ARN), and that the exemption does **not** leak into the region or data-copy guards. The evaluator implements only the operators these policies use and follows IAM's missing-key rule for negated operators.

## 5. Validate the action names against AWS (needs credentials, read-only)

A Deny on an action that does not exist matches nothing and looks like protection. Several names in the data-copy list were written from the service authorisation reference without an AWS lookup (`oam:*Link`/`Sink`, `elasticache:*ServerlessCacheSnapshot`, `ecr:ReplicateImage`, `account:TargetRegion`, `access-analyzer:DeleteAnalyzer`, and the SES API endpoint service name `email` in the network module). Validate before attaching anything:

```bash
SCP_VARS_JSON=vars.json AWS_REGION=<approved region> bash infra/scripts/scp-validate.sh
```

It runs IAM Access Analyzer `validate-policy` with policy type `SERVICE_CONTROL_POLICY` on each rendered document and fails on any `ERROR`. Fix the module, never the test, if it reports an unknown action or key.

## 6. Roll out

1. **Plan** from the management account (`TF_VAR_management_account_id` set; the provider refuses any other account). Read the three documents and the attachment list. `document_sizes` must stay under 5,120.
2. **Apply to the test OU / throwaway account only.** Then, in that account:
   - Expected **denied** (each should return an explicit deny from a service control policy): an `ec2 describe-vpcs` in a region that is not approved; `s3api put-bucket-replication` on a scratch bucket; `kms create-key --multi-region`; `rds create-db-instance-read-replica`; `cloudtrail stop-logging` as a non-exempt role.
   - Expected **allowed**: `sts get-caller-identity`; `iam list-roles`; the same `ec2 describe-vpcs` in the approved region; `s3api put-object` on the scratch bucket; the platform stack's own `plan` (staging root pointed at this account).
   - Apply the **staging platform** into that account and confirm: ECS tasks start and pull the image, secrets inject, the Route 53 health-check alarm and SNS topic are created in `us-east-1`, SES sending works, and the RDS PITR restore path still works. If interface endpoints are enabled (T15), a failing task start is the sign that the endpoint policy or an endpoint service name is wrong — see `COST-MODEL.md` §6.
   - Keep the policy-simulator / CLI output as evidence (residency plan section 20).
3. Attach to the **production OU**. Re-check the same positive list against production with a read-only `terraform plan` of the production root: it must show no change and no authorisation error.
4. Attach to the **organisation root** last, only if every member account should be bound.
5. Record: policy ids, the commit of this module, the approved-region list and where the written approval is kept.

## 7. Roll back

Any one of these, from the management account (which is never restricted):

- remove the target from `target_ids` and apply; or
- `aws organizations detach-policy --policy-id <p-…> --target-id <ou-…>` for the policy that is blocking; or
- as a last resort, detach all three policies from the target.

A wrong `region-boundary` locks a member account out of everything except global services, including the actions needed to fix it from inside that account. That is why step 6 begins with a throwaway account.

## 8. Day-2

- **Adding a region** (new hosting decision, DR destination): change `approved_regions` here **and** in the environment tfvars in the same reviewed change. The gate fails if only one side moves.
- **Enabling DR:** add the destination vault ARN to `approved_backup_vault_arns` and the region to `approved_regions`; both need the written DR decision (L13).
- **A new AWS service or feature that can copy data** is not covered until it is added to `data_copy_catalogue` in `policies/main.tf` with a test and a line in the evaluator test. Review the AWS "What's new" feed with that in mind each quarter.
- **A tenant integration or a new vendor** is application egress, not an SCP matter: it belongs in `src/modules/data-governance/subprocessor-register.ts`.

## 9. Open items (do not treat as settled)

| Item | Status |
|---|---|
| An AWS Organization exists; policy type enabled | unknown — owner to confirm |
| The approved region list | owner + counsel (L1/L2); only the owner's 2026-10-08 chat decision for the platform stack exists, which this module does not assume |
| Action names and condition keys listed in section 5 | to be validated with `scp-validate.sh` |
| `account:TargetRegion` behaviour for `EnableRegion` | `OV` |
| Whether the SES API interface-endpoint service name is `email` in the target region | `OV` (Launch Readiness Gate) |
| Behaviour with IAM Identity Center sessions, AWS Backup service role, and ECS agent calls under these SCPs | **not exercised** — step 6.2 is the first real test |

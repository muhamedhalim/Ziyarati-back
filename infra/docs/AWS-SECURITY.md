# AWS security and data-boundary controls

Companion to `SECURITY.md` (the phased control design, IAM, WAF, tenancy) and to `DATA-RESIDENCY.md` (the boundary). This file is the **map from each boundary control to the module, the test and the runbook that carry it**, so a reviewer can see what is real. Nothing here has been applied to an AWS account; "tested" means `terraform test` against a mocked provider or an offline evaluator.

## 1. Preventive

| Control | Module / file | Test |
|---|---|---|
| Region allow-list; no default; region must be a member | `modules/platform/variables.tf`, env `variables.tf` | `platform.tftest.hcl` |
| Backup copy only to approved destinations | `platform` `approved_dr_destinations` | `platform.tftest.hcl` |
| No region literals, no replication / multi-Region / CloudFront / Bedrock constructs in source | `scripts/region-gate.sh` | CI `static` |
| Single-Region KMS keys (multi-Region keys refused by source scan) | `modules/kms`, `modules/backup` | `kms.tftest.hcl`, `backup.tftest.hcl`; CI `static` |
| S3: public access blocked, TLS-only, CMK, versioning, replication denied by bucket policy | `modules/s3-uploads` | `s3.tftest.hcl` |
| RDS: encrypted with env CMK, not public, TLS forced (replica / backup replication absence is a source scan, not a module test) | `modules/rds`, `scripts/region-gate.sh` | `rds.tftest.hcl`; CI `static` |
| Valkey: transit + at-rest encryption, Multi-AZ failover; no global datastore (source scan) | `modules/elasticache`, `scripts/region-gate.sh` | `elasticache.tftest.hcl`; CI `static` |
| Secrets: no replicas | `modules/secrets` | `secrets.tftest.hcl` |
| ECR: no replication (source scan; a test cannot assert a resource is absent) | `scripts/region-gate.sh` | CI `static` |
| Organisation SCPs (region boundary, data-copy guard, audit guard) | `modules/org-guardrails` + `environments/org-guardrails` | `policies.tftest.hcl`, `org-guardrails.tftest.hcl`, `scp-semantics.test.cjs` |
| CloudWatch Logs data-protection policy (mask e-mail, Saudi mobile and national-ID patterns, JWTs, pre-signed signatures) on every log group the stack owns; backstop behind application scrubbing; `enable_log_data_protection`, default on | `modules/log-protection`, wired in `modules/platform` | `log-protection.tftest.hcl`, `platform.tftest.hcl` |
| AWS API calls over PrivateLink instead of NAT (off by default; cost in `COST-MODEL.md` section 6) | `modules/network/interface_endpoints.tf` | `network.tftest.hcl` |
| Production release gate | `compliance/production-gate.yaml`, `scripts/production-gate.cjs` | `production-gate.test.cjs` |

## 2. Detective

CloudTrail (multi-region, validation on, S3 data events on uploads) and GuardDuty and Access Analyzer in `modules/account-baseline`; VPC flow logs; WAF logs with cookies / authorization redacted. The audit guard SCP keeps them from being switched off (except by the named exempt roles). AWS Config and Security Hub are **deferred** (plan section 23, tag D).

## 3. Access

Least-privilege task roles (API is not worker; tested in `ecs.tftest.hcl`), GitHub OIDC deploy roles with trust pinned to the repository and Environment, no IAM users, Identity Center for people. Break-glass role with MFA is a **runbook item**, not provisioned here (`CV`).

## 4. Plan items not found in the repository

The residency plan lists these under section 13; a search of `infra/terraform` found no implementation. They are open, not done, and have no test.

| Plan item | What is missing |
|---|---|
| T19 | An `enable_ses` toggle; the SES module is always created, so a Region without SES forces a second Region or a code change |
| T18 (partial) | Provider `default_tags` carry `DataClassification` and `Region`; the plan also named `DataClass` and `Residency` |

Verify before treating any as closed: this list comes from a source search, not from running the modules.

## 5. What would be proven only by a real account

Task start under the SCPs and the endpoint policy; the health-check alarm and SNS topic in `us-east-1`; RDS PITR restore; SES sending; ECS agent and AWS Backup service-role behaviour under the SCPs; every action name in the SCP data-copy list (`scripts/scp-validate.sh` validates them with Access Analyzer and has not been run). Staging apply is the first real test (`runbooks/org-guardrails-rollout.md` section 6).

## 6. Support and operations access

No patient data in AWS support cases, resource names, tags or descriptions. Operators work through Identity Center permission sets; production console access is read-only by default (`CV` against the account once it exists).

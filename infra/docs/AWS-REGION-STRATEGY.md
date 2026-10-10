# AWS Region strategy

Residency plan sections 1, 8, 22. **No AWS Region is inside Saudi Arabia today** (`C` at the plan's audit date; check the official Regions page before relying on that, `OV`). This document says how the stack is parameterised so a Region can be added or moved safely; it does not choose a Region. Choosing one is a legal decision (L1/L2, `PDPL-COMPLIANCE.md`).

## Current state

| Item | State |
|---|---|
| Stack Region | `eu-central-1`, from the owner's 2026-10-08 chat decision (D-1); in `approved_regions` in `environments/production/terraform.tfvars` |
| Legal approval of that location | **none recorded**; production-gate item `legal-hosting-approval` is open |
| State | one state per Region: key `platform/<region>/terraform.tfstate`, Region supplied by `backend.hcl` |
| Organisation SCP list | empty on purpose (`environments/org-guardrails`); not applied |
| Saudi Region | not available; announced date and service list unverified (`OV`) |
| Anything applied | nothing |

## Rules

1. **A Region is never changed in place.** Flipping `aws_region` on an existing state makes Terraform destroy and recreate everything. Each Region gets its own state key and its own stack from the same modules; data moves by backup / restore; DNS switches last.
2. **One allow-list.** `approved_regions` is empty by default. `aws_region` must be a member; `dr_backup_region` must be empty or in `approved_dr_destinations`. The organisation SCP list must be a superset of every environment's regions (`region-gate.sh` checks both directions).
3. **No region literal in Terraform** except the documented `us-east-1` alias for the Route 53 health-check alarm (`region-gate.sh static`).
4. **Per-Region recreation:** KMS keys, secrets, certificates, ECR images and SES identities are recreated in each Region; none is replicated.
5. **Adding a Region** is one reviewed change that touches the environment tfvars **and** the organisation SCP list together; the gate fails if only one moves.

## Per-Region facts to confirm (Launch Readiness Gate)

The gate fails if any line is not evidenced from AWS's official service list or a live check **in that Region**. Nothing below is assumed.

| Check | Must be true |
|---|---|
| Region generally available and enabled for the account | yes |
| RDS PostgreSQL (required major version, Multi-AZ, PITR, Performance Insights if kept, CA bundle) | available |
| ECS + Fargate (platform version, architecture in use) | available |
| ElastiCache Valkey (version, TLS, Multi-AZ) | available |
| S3 (versioning, lifecycle, gateway endpoint), KMS, Secrets Manager | available |
| CloudWatch Logs / metrics / alarms; CloudTrail incl. S3 data events | available |
| ALB, regional WAF with the managed rule groups in use, ACM | available |
| ECR, SQS, SNS, EventBridge, GuardDuty, IAM Access Analyzer | available |
| SES | available, or the alternative e-mail path is approved |
| AWS Backup for RDS | available |
| VPC interface endpoints for each service in `interface_endpoint_services` (the SES endpoint service name `email` is unverified) | available |
| Three Availability Zones usable by the account | yes |
| Service-managed storage (RDS backups / snapshots, Performance Insights, CloudTrail history, ElastiCache snapshots) documented as in-Region | yes |
| Backup and DR destination decided (`DISASTER-RECOVERY.md` section 5) | yes |
| Support / operations access terms for the Region reviewed | yes |
| Staging stack applied, tested and restore-drilled in the Region | yes |
| Counsel confirms the move and the decommissioning of the interim location | yes |

## Sequence

0. Legal-independent engineering (done in this repository).
1. Staging in an approved Region, synthetic data only. Legal approval is still needed if that Region will later hold real data.
2. Production cut-over from Railway: after the production gate (`compliance/README.md`); sequence in `MIGRATION.md`, plus deletion evidence from Railway, R2 and Resend afterwards.
3. Move to a Saudi Region when one is live: Launch Readiness Gate above, new stack and state key, data migration, DNS, decommission the interim Region.

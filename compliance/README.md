# Compliance manifest

`production-gate.yaml` is the production-readiness gate from the Saudi data-residency plan (section 16). It is a **release gate**, not a compliance certificate: it records whether the evidence a production deploy needs exists, and it fails the deploy when it does not.

## States

| Item kind | How it becomes satisfied | Who can claim it |
|---|---|---|
| `legal`, `document` | set `status: satisfied` with `evidence`, `approved_by`, `date` in a reviewed pull request | a person, with the document in hand |
| `technical` | cannot be hand-set. It names the test files and the workflow commands that run them; the gate fails if either disappears | CI |

Evidence is a path in this repository (it must exist) or `external: <where the document is kept>`. Privileged documents (counsel's opinion, signed DPAs) are **not** committed; they live in the contract repository and are referenced.

Every `legal` / `document` item is `open` today. Do not change one without the document.

## Commands

```bash
node infra/scripts/production-gate.cjs validate   # structure only; passes while items are open
node infra/scripts/production-gate.cjs enforce    # fails unless every item is satisfied
node --test infra/scripts/tests/production-gate.test.cjs
```

## Where it runs

| Workflow | Mode | When |
|---|---|---|
| `terraform.yml` `static` | validate | every pull request |
| `terraform.yml` `preview`, `apply` | enforce | manual production apply |
| `deploy-aws.yml` `deploy-production` | enforce | production deploy; **skipped for a rollback** (`image_tag` set), so a regressed item can never block recovery |

`enforce` is one gate among others: the GitHub Environment's required reviewers remain the final human control, and `region-gate.sh deploy` independently refuses an unapproved Region.

## Consistency with code

`src/modules/data-governance/compliance-docs.spec.ts` fails if `dpa-critical-processors`, `scc-or-alternative` or `transfer-inventory-complete` is marked satisfied while the subprocessor register still lists that evidence as missing. It also fails when a generated table in `infra/docs` differs from its register.

## Items

| Id | What it asks for |
|---|---|
| `legal-hosting-approval` | written legal approval of the hosting location (L1/L2) |
| `transfer-inventory-complete` | every flow reviewed and each processor registered |
| `dpa-critical-processors` | a DPA per critical processor |
| `scc-or-alternative` | SCCs or counsel's alternative, and risk assessments where required |
| `ai-minimiser-tests`, `log-scrubbing-tests`, `data-boundary-terraform-tests` | the test suites exist and run in CI |
| `scps-applied` | SCPs applied, policy-simulator evidence kept |
| `restore-drill-record` | a dated restore drill with measured RTO/RPO |
| `incident-response-runbook` | runbook completed and exercised once |

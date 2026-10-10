# Incident response — personal-data breach and security incidents

Residency plan sections 16, 19, 23. **A scaffold.** The technical steps use controls that exist in this repository. Everything that depends on law or on a person (who is notified, by when, in what form, who is on call) is left blank on purpose: the PDPL breach-notification deadline, the recipient and the content are `OV`/`LC` and are **not stated here**. Production-gate item `incident-response-runbook` stays open until the blanks are filled and the runbook has been exercised once.

## 1. Fill in before first use

| Item | Value |
|---|---|
| Incident commander (primary / backup) | |
| Technical lead | |
| Counsel / DPO contact | |
| Regulator notification: recipient, channel, **deadline** (from counsel, `LC`) | |
| Clinic (controller) notification: contact per tenant, deadline from the contract | |
| Processor contacts (OpenAI, Meta, Tap, Vercel, e-mail provider, AWS) | |
| Where incident records are kept (access-restricted) | |
| Out-of-hours alert route | `docs/SECURITY_ALERTING_HANDOFF.md` |

## 2. Detect

Sources that exist: GuardDuty findings and IAM Access Analyzer (`modules/account-baseline`), CloudTrail incl. S3 data events on uploads, WAF logs, ALB alarms and the health-check alarm (`modules/monitoring`), application security events and the platform-admin audit trail, `clinical_access_logs` (D4 reads), vendor notices. Not yet in place: AWS Config / Security Hub (deferred), a tested alert route to a human (`CV`).

## 3. Triage (first hour)

1. Open an incident record: time, reporter, what was seen. Do not paste patient data into tickets, chat or support cases.
2. Decide scope with facts: which tenants, which data classes (`DATA-CLASSIFICATION.md`), which flow (`DATA-FLOW.md`), which processor (`SUBPROCESSORS.md`).
3. Classify for internal priority only (this is not a legal classification):
   - **P1** — confirmed or probable exposure of D2-D6 data, or loss of integrity of clinical records.
   - **P2** — attempted or contained exposure; credential or secret exposure with no evidence of use.
   - **P3** — vulnerability with no evidence of exploitation.
4. If P1 or P2: tell the incident commander and counsel now; the legal clock questions (L5, section 1 above) start from counsel's answer, not from a number in this file.

## 4. Contain (use what exists)

| Situation | Action | Reference |
|---|---|---|
| Credentials or tokens leaked | rotate the secret; revoke sessions; for tenant provider credentials rotate and re-encrypt | `DISASTER-RECOVERY.md` DR-7 |
| A channel is leaking content | disable that channel per tenant (WhatsApp, e-mail via provider switch `noop`), or the AI feature | `TRANSFER-IMPACT-ASSESSMENT.md` off-switch column |
| A tenant account is abused | suspend the tenant (offboarding requires it inactive anyway) | `tenant-offboarding.service.ts` |
| A bad release | roll back by image tag | `deploy-aws.yml`, `DEPLOYMENT.md` |
| AWS account suspected compromised | revoke the apply / deploy roles, rotate the KMS-protected secrets, preserve CloudTrail first | `SECURITY.md` section 2 |
| Data copied out of the Region by an AWS feature | the SCP data-copy guard should have denied it; treat as a control failure and record it | `runbooks/org-guardrails-rollout.md` |

## 5. Preserve evidence

CloudTrail log-file validation stays on; do not delete or shorten any log, bucket version or backup while the incident is open (retention sweeps in `RETENTION-POLICY.md` are inert unless configured). Export the relevant window of CloudTrail, WAF and application logs to the incident record. Application logs are scrubbed at write time, so they show shape, not content: expect to correlate through ids.

## 6. Notify (blanks to be filled with counsel)

| Who | When | Content | Owner | Sent (date / ref) |
|---|---|---|---|---|
| Regulator | per counsel (`LC`) | per counsel | | |
| Affected clinics (controllers) | per contract / counsel | what, when, which data classes, what to do | | |
| Affected individuals | only if counsel / the clinic decides | | | |
| Processors involved | as needed | | | |

Ziyarati acts as a processor for clinic data and may be a controller for some flows (L9). Who notifies whom depends on that split; do not assume it.

## 7. Recover and close

Restore from backup only after the entry path is closed (`DISASTER-RECOVERY.md` DR-1..DR-6). Record root cause, data classes and tenants affected, actions taken, deletion evidence where data was removed, and the control that failed. Add a test or a gate for the failure where one is possible. Update `PDPL-COMPLIANCE.md` if an outstanding item changed.

## 8. Exercise

Run one tabletop with a P1 scenario before production (gate item `incident-response-runbook`); record date, participants and gaps found. Re-run after any change to section 1.

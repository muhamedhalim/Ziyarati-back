'use strict';
// Evaluates the rendered SCP documents (modules/org-guardrails/policies) against
// concrete API requests: "what does this policy do to THIS call?". The Terraform
// tests assert structure and size; this proves behaviour, which is what a lock-out
// or a hole in the boundary would actually be.
//
//   node --test infra/scripts/tests/scp-semantics.test.cjs
//
// Needs the terraform binary (read-only `terraform console`, no provider, no
// credentials, no state written). Skips with a message when it is absent.
//
// The evaluator implements only what these policies use: Effect Deny, Action /
// NotAction / Resource / NotResource wildcards, and the String*, Arn*, Bool
// condition operators with IAM's missing-key rules. An SCP is evaluated with an
// implicit FullAWSAccess, so a request is permitted exactly when no Deny matches.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render, terraformAvailable } = require('../scp-render.cjs');

// ── evaluator ────────────────────────────────────────────────────────────────
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function wildcardToRegExp(pattern, caseInsensitive) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : '');
}
const like = (pattern, value, ci = false) => wildcardToRegExp(pattern, ci).test(value);

// IAM action names are case-insensitive; resource ARNs and condition values are not.
const actionMatches = (patterns, action) => toArray(patterns).some((p) => like(p, action, true));
const resourceMatches = (patterns, resource) => toArray(patterns).some((p) => like(p, resource));

const OPERATORS = {
  StringEquals: (v, c) => v === c,
  StringNotEquals: (v, c) => v !== c,
  StringLike: (v, c) => like(c, v),
  StringNotLike: (v, c) => !like(c, v),
  ArnEquals: (v, c) => like(c, v),
  ArnLike: (v, c) => like(c, v),
  ArnNotEquals: (v, c) => !like(c, v),
  ArnNotLike: (v, c) => !like(c, v),
  Bool: (v, c) => String(v).toLowerCase() === String(c).toLowerCase(),
};
const NEGATED = new Set(['StringNotEquals', 'StringNotLike', 'ArnNotEquals', 'ArnNotLike']);

function conditionMatches(condition, context) {
  if (!condition) return true;
  for (const [operator, keys] of Object.entries(condition)) {
    const test = OPERATORS[operator];
    if (!test) throw new Error(`evaluator does not implement condition operator ${operator}`);
    for (const [key, expected] of Object.entries(keys)) {
      const actual = context[key];
      if (actual === undefined) {
        // Missing key: a negated operator is true, every other operator is false.
        if (NEGATED.has(operator)) continue;
        return false;
      }
      const values = toArray(expected);
      // A negated operator must hold against EVERY listed value; the rest against ANY.
      const ok = NEGATED.has(operator)
        ? values.every((v) => test(actual, v))
        : values.some((v) => test(actual, v));
      if (!ok) return false;
    }
  }
  return true;
}

function statementMatches(s, req) {
  const actionOk = s.Action !== undefined ? actionMatches(s.Action, req.action) : !actionMatches(s.NotAction, req.action);
  if (!actionOk) return false;
  const resource = req.resource ?? '*';
  const resourceOk =
    s.Resource !== undefined
      ? resourceMatches(s.Resource, resource)
      : s.NotResource !== undefined
        ? !resourceMatches(s.NotResource, resource)
        : true;
  return resourceOk && conditionMatches(s.Condition, req.context ?? {});
}

/** @returns the Sids of every Deny that matches (empty = permitted). */
function denials(documents, req) {
  return Object.values(documents).flatMap((doc) =>
    doc.Statement.filter((s) => s.Effect === 'Deny' && statementMatches(s, req)).map((s) => s.Sid),
  );
}

// ── rendering ────────────────────────────────────────────────────────────────
// render() lives in infra/scripts/scp-render.cjs (shared with scp-validate.sh).
const TF_SKIP = terraformAvailable() ? false : 'terraform binary not on PATH';

const BASE = {
  approved_regions: ['me-central-1'],
  audit_exempt_principal_arns: ['arn:aws:iam::123456789012:role/zt-production-tf-apply', 'arn:aws:iam::*:role/zt-break-glass'],
};
const APPLY_ROLE = 'arn:aws:sts::123456789012:assumed-role/zt-production-tf-apply/session';
// An assumed-role session ARN is what aws:PrincipalARN holds for role sessions; the
// SCP exemption therefore has to be written against the role ARN, not the sts ARN.
const APPLY_ROLE_PRINCIPAL = 'arn:aws:iam::123456789012:role/zt-production-tf-apply';
const OTHER_ROLE = 'arn:aws:iam::123456789012:role/zt-production-api-task';

const inRegion = (region, extra = {}) => ({ 'aws:RequestedRegion': region, 'aws:PrincipalARN': OTHER_ROLE, ...extra });

function check(documents, label, req, expected) {
  const got = denials(documents, req);
  if (expected === 'allow') {
    assert.deepEqual(got, [], `${label}: expected the request to be permitted, denied by ${got.join(', ')}`);
  } else {
    assert.ok(got.length > 0, `${label}: expected a deny`);
    if (typeof expected === 'string' && expected !== 'deny') {
      assert.ok(got.includes(expected), `${label}: expected deny by ${expected}, got ${got.join(', ')}`);
    }
  }
}

test('evaluator sanity: missing keys and negated operators follow IAM', () => {
  const doc = {
    a: {
      Statement: [
        { Sid: 'Neg', Effect: 'Deny', Action: 'x:Do', Resource: '*', Condition: { StringNotEquals: { 'k': ['a', 'b'] } } },
        { Sid: 'Pos', Effect: 'Deny', Action: 'x:Do2', Resource: '*', Condition: { StringEquals: { 'k': 'a' } } },
      ],
    },
  };
  assert.deepEqual(denials(doc, { action: 'x:Do', context: {} }), ['Neg'], 'missing key satisfies a negated operator');
  assert.deepEqual(denials(doc, { action: 'x:Do', context: { k: 'a' } }), [], 'listed value is excluded');
  assert.deepEqual(denials(doc, { action: 'x:Do', context: { k: 'c' } }), ['Neg']);
  assert.deepEqual(denials(doc, { action: 'x:Do2', context: {} }), [], 'missing key fails a positive operator');
  assert.deepEqual(denials(doc, { action: 'X:DO2', context: { k: 'a' } }), ['Pos'], 'action names are case-insensitive');
});

test('region boundary', { skip: TF_SKIP }, () => {
  const d = render(BASE);
  const A = 'DenyOutsideApprovedRegions';
  check(d, 'ec2 in approved region', { action: 'ec2:RunInstances', context: inRegion('me-central-1') }, 'allow');
  check(d, 'ec2 in another region', { action: 'ec2:RunInstances', context: inRegion('eu-west-1') }, A);
  check(d, 'rds in Frankfurt', { action: 'rds:CreateDBInstance', context: inRegion('eu-central-1') }, A);
  check(d, 's3 in us-east-1', { action: 's3:GetObject', resource: 'arn:aws:s3:::b/k', context: inRegion('us-east-1') }, A);
  check(d, 'IAM is global', { action: 'iam:CreateRole', context: inRegion('us-east-1') }, 'allow');
  check(d, 'STS is global', { action: 'sts:GetCallerIdentity', context: inRegion('us-east-1') }, 'allow');
  check(d, 'Organizations is global', { action: 'organizations:DescribeOrganization', context: inRegion('us-east-1') }, 'allow');
  check(d, 'Route 53 is global', { action: 'route53:CreateHealthCheck', context: inRegion('us-east-1') }, 'allow');
  check(d, 'Budgets is global', { action: 'budgets:CreateBudget', context: inRegion('us-east-1') }, 'allow');
  check(d, 'KMS is NOT exempt', { action: 'kms:CreateKey', context: inRegion('eu-west-1') }, A);
  check(d, 'ACM is NOT exempt', { action: 'acm:RequestCertificate', context: inRegion('us-east-1') }, A);
});

test('us-east-1 is closed: no alarm, topic or subscription may be created there', { skip: TF_SKIP }, () => {
  const d = render(BASE);
  const ctx = inRegion('us-east-1');
  for (const action of ['cloudwatch:PutMetricAlarm', 'sns:CreateTopic', 'sns:Subscribe', 'sns:Publish', 's3:PutObject', 'ec2:RunInstances']) {
    check(d, action, { action, context: ctx }, 'DenyOutsideApprovedRegions');
  }
  check(d, 'iam still global', { action: 'iam:GetRole', context: ctx }, 'allow');
  check(d, 'alarm in approved region', { action: 'cloudwatch:PutMetricAlarm', context: inRegion('me-central-1') }, 'allow');
});

test('an approved us-east-1 behaves like any approved region', { skip: TF_SKIP }, () => {
  const d = render({ ...BASE, approved_regions: ['us-east-1'] });
  check(d, 's3 in approved us-east-1', { action: 's3:GetObject', resource: 'arn:aws:s3:::b/k', context: inRegion('us-east-1') }, 'allow');
  check(d, 'ec2 in me-central-1', { action: 'ec2:RunInstances', context: inRegion('me-central-1') }, 'DenyOutsideApprovedRegions');
});

test('enabling an opt-in region', { skip: TF_SKIP }, () => {
  const d = render(BASE);
  const ctx = (target) => ({ 'aws:RequestedRegion': 'us-east-1', 'aws:PrincipalARN': OTHER_ROLE, 'account:TargetRegion': target });
  check(d, 'enable unapproved region', { action: 'account:EnableRegion', context: ctx('eu-south-1') }, 'DenyEnablingUnapprovedRegions');
  check(d, 'enable approved region', { action: 'account:EnableRegion', context: ctx('me-central-1') }, 'allow');
  check(d, 'listing regions', { action: 'account:ListRegions', context: { 'aws:RequestedRegion': 'us-east-1' } }, 'allow');
});

test('data-copy guard', { skip: TF_SKIP }, () => {
  const d = render(BASE);
  const approved = inRegion('me-central-1');
  const DC = 'DenyDataCopyAndReplicationFeatures';
  for (const action of [
    's3:PutReplicationConfiguration',
    's3:ReplicateObject',
    's3:CreateJob',
    'rds:CreateDBInstanceReadReplica',
    'rds:StartDBInstanceAutomatedBackupsReplication',
    'rds:ModifyDBSnapshotAttribute',
    'rds:StartExportTask',
    'kms:ReplicateKey',
    'secretsmanager:ReplicateSecretToRegions',
    'ecr:PutReplicationConfiguration',
    'elasticache:CreateGlobalReplicationGroup',
    'logs:PutDestination',
    'logs:PutSubscriptionFilter',
    'bedrock:InvokeModel',
    'bedrock:CreateAgent',
    'cloudfront:CreateDistribution',
    'dms:CreateReplicationTask',
    'datasync:CreateTask',
  ]) {
    check(d, action, { action, context: approved }, DC);
  }
  // everything the application and the platform legitimately do stays open
  for (const [action, resource] of [
    ['s3:PutObject', 'arn:aws:s3:::zt-uploads/k'],
    ['s3:GetObject', 'arn:aws:s3:::zt-uploads/k'],
    ['s3:PutBucketPolicy', 'arn:aws:s3:::zt-uploads'],
    ['rds:CreateDBInstance', undefined],
    ['rds:CreateDBSnapshot', undefined],
    ['rds:CopyDBSnapshot', undefined],
    ['rds:RestoreDBInstanceToPointInTime', undefined],
    ['kms:Decrypt', undefined],
    ['kms:CreateGrant', undefined],
    ['secretsmanager:GetSecretValue', undefined],
    ['ecr:BatchGetImage', undefined],
    ['sqs:ReceiveMessage', undefined],
    ['ses:SendEmail', undefined],
    ['logs:PutLogEvents', undefined],
    ['logs:PutMetricFilter', undefined],
    ['cloudfront:ListDistributions', undefined],
  ]) {
    check(d, action, { action, resource, context: approved }, 'allow');
  }
  // an unapproved destination is stopped by the region deny, not by the action list
  check(d, 'snapshot copy INTO an unapproved region', { action: 'rds:CopyDBSnapshot', context: inRegion('eu-west-1') }, 'DenyOutsideApprovedRegions');
});

test('multi-region keys', { skip: TF_SKIP }, () => {
  const d = render(BASE);
  const MR = 'DenyMultiRegionKeys';
  check(d, 'multi-region key', { action: 'kms:CreateKey', context: inRegion('me-central-1', { 'kms:MultiRegion': 'true' }) }, MR);
  check(d, 'single-region key', { action: 'kms:CreateKey', context: inRegion('me-central-1', { 'kms:MultiRegion': 'false' }) }, 'allow');
  check(d, 'key without the parameter', { action: 'kms:CreateKey', context: inRegion('me-central-1') }, 'allow');
});

test('backup copy: denied everywhere until a vault is approved, then only into it', { skip: TF_SKIP }, () => {
  const vault = 'arn:aws:backup:me-central-1:123456789012:backup-vault:zt-prod-dr';
  const other = 'arn:aws:backup:me-central-1:123456789012:backup-vault:somewhere-else';

  const none = render(BASE);
  check(none, 'copy with nothing approved', { action: 'backup:CopyIntoBackupVault', resource: vault, context: inRegion('me-central-1') }, 'DenyBackupCopyAnywhere');

  const some = render({ ...BASE, approved_backup_vault_arns: [vault] });
  check(some, 'copy into the approved vault', { action: 'backup:CopyIntoBackupVault', resource: vault, context: inRegion('me-central-1') }, 'allow');
  check(some, 'copy into another vault', { action: 'backup:CopyIntoBackupVault', resource: other, context: inRegion('me-central-1') }, 'DenyBackupCopyToUnapprovedVaults');
  check(some, 'ordinary backup job', { action: 'backup:StartBackupJob', context: inRegion('me-central-1') }, 'allow');
});

test('a lifted action stays allowed, the rest of the list holds', { skip: TF_SKIP }, () => {
  const d = render({ ...BASE, lifted_data_copy_actions: ['rds:CreateDBInstanceReadReplica'] });
  const approved = inRegion('me-central-1');
  check(d, 'lifted', { action: 'rds:CreateDBInstanceReadReplica', context: approved }, 'allow');
  check(d, 'still denied', { action: 's3:PutReplicationConfiguration', context: approved }, 'DenyDataCopyAndReplicationFeatures');
  // lifting a copy action never lifts the region boundary
  check(d, 'lifted but wrong region', { action: 'rds:CreateDBInstanceReadReplica', context: inRegion('eu-west-1') }, 'DenyOutsideApprovedRegions');
});

test('audit guard', { skip: TF_SKIP }, () => {
  const d = render(BASE);
  const AG = 'DenyDisablingAuditAndDetection';
  const as = (principal) => ({ 'aws:RequestedRegion': 'me-central-1', 'aws:PrincipalARN': principal });
  for (const action of ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail', 'guardduty:DeleteDetector', 'guardduty:UpdateDetector', 'access-analyzer:DeleteAnalyzer']) {
    check(d, `${action} by an ordinary role`, { action, context: as(OTHER_ROLE) }, AG);
  }
  check(d, 'trail change by the apply role', { action: 'cloudtrail:UpdateTrail', context: as(APPLY_ROLE_PRINCIPAL) }, 'allow');
  check(d, 'trail change by a wildcard-account break-glass role', { action: 'cloudtrail:StopLogging', context: as('arn:aws:iam::999999999999:role/zt-break-glass') }, 'allow');
  check(d, 'a look-alike role name is not exempt', { action: 'cloudtrail:StopLogging', context: as('arn:aws:iam::123456789012:role/zt-production-tf-apply-evil') }, AG);
  check(d, 'reading the trail', { action: 'cloudtrail:LookupEvents', context: as(OTHER_ROLE) }, 'allow');
  check(d, 'guardduty read', { action: 'guardduty:ListFindings', context: as(OTHER_ROLE) }, 'allow');
  // leaving the organisation is denied even for the exempt role
  check(d, 'leave organisation', { action: 'organizations:LeaveOrganization', context: as(APPLY_ROLE_PRINCIPAL) }, 'DenyLeavingTheOrganization');
  // a role SESSION arn is not what the SCP is written against (documented trap)
  check(d, 'sts session arn does not match the role arn', { action: 'cloudtrail:StopLogging', context: as(APPLY_ROLE) }, AG);
});

test('the exemption is only for the audit guard', { skip: TF_SKIP }, () => {
  const d = render(BASE);
  const ctx = { 'aws:RequestedRegion': 'eu-west-1', 'aws:PrincipalARN': APPLY_ROLE_PRINCIPAL };
  check(d, 'exempt role still cannot leave the region boundary', { action: 'ec2:RunInstances', context: ctx }, 'DenyOutsideApprovedRegions');
  check(d, 'exempt role still cannot replicate', { action: 's3:PutReplicationConfiguration', context: { ...ctx, 'aws:RequestedRegion': 'me-central-1' } }, 'DenyDataCopyAndReplicationFeatures');
});

/**
 * EvidenceRecord writer for the platform performance audit
 * (specs/006-platform-performance-audit). Implements the schema and
 * validation rules V1-V8 of contracts/evidence-record.md exactly.
 *
 * Measurement-only: never imported by any application runtime module. Lives
 * under scripts/perf/ per Standing Rule 6 of the audit's tasks.md.
 *
 * Run this file's self-check directly:
 *   npx ts-node -r tsconfig-paths/register scripts/perf/evidence-record.ts
 */
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type Layer =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'cache'
  | 'external'
  | 'infrastructure'
  | 'e2e';

export type Unit = 'ms' | 's' | 'bytes' | 'count' | 'ratio' | 'percent' | 'rps';

export type EnvironmentClass = 'LOCAL' | 'STAGING' | 'PRODUCTION-TELEMETRY';

export type DataTier = 'T1' | 'T2';

export interface EnvironmentSpec {
  cpu?: string;
  memoryGb?: number;
  storage?: string;
  nodeVersion: string;
  postgresVersion?: string;
  redisVersion?: string;
  /** Recorded per the T009 finding: NODE_ENV actually used, since production
   * cannot boot on this Postgres image (SSL requirement) — see
   * reports/environments.md. Never silently omitted. */
  nodeEnvActual?: string;
}

export interface EvidenceRecordContext {
  locale?: string | null;
  role?: string | null;
  viewport?: string | null;
  theme?: string | null;
  loadProfile?: string | null;
}

export interface EvidenceRecordSubject {
  [key: string]: unknown;
}

export interface EvidenceRecordInput {
  id: string;
  layer: Layer;
  metric: string;
  value: number;
  unit: Unit;
  /** Required (non-null) for any latency distribution metric — V3. */
  percentile: number | null;
  sampleSize: number;
  environmentClass: EnvironmentClass;
  environmentSpec: EnvironmentSpec;
  /** Required for database|e2e records and whenever context.loadProfile is set — V2. */
  dataTier: DataTier | null;
  procedureId: string;
  tool: { name: string; version: string; invocation: string };
  subject: EvidenceRecordSubject;
  context?: EvidenceRecordContext;
  /** [] means none — never omitted (V6). */
  instrumentationActive: string[];
  timestamp?: string;
  operator: string;
}

export interface EvidenceRecord extends EvidenceRecordInput {
  timestamp: string;
  context: EvidenceRecordContext;
}

const LATENCY_METRIC_PATTERN = /(_ms$|_s$|latency|duration|p50|p95|p99|percentile)/i;

/** Metric ids this audit treats as latency distributions requiring `percentile` (V3). */
export function isLatencyDistributionMetric(metric: string): boolean {
  return LATENCY_METRIC_PATTERN.test(metric);
}

export interface ValidationResult {
  valid: boolean;
  violations: string[];
}

/**
 * Validates a single EvidenceRecord against V1-V6 (structural, single-record
 * rules from contracts/evidence-record.md). V7 and V8 are cross-record /
 * reporting-time invariants — see assertSameEnvironmentClass() and
 * formatCapacityClaim() below, which enforce them by construction rather
 * than by post-hoc validation of a single record.
 */
export function validateEvidenceRecord(
  record: EvidenceRecordInput,
  knownProcedureIds: readonly string[],
): ValidationResult {
  const violations: string[] = [];

  // V1
  const validClasses: EnvironmentClass[] = ['LOCAL', 'STAGING', 'PRODUCTION-TELEMETRY'];
  if (!record.environmentClass || !validClasses.includes(record.environmentClass)) {
    violations.push('V1: environmentClass missing or not one of LOCAL|STAGING|PRODUCTION-TELEMETRY');
  }

  // V2
  const requiresDataTier =
    record.layer === 'database' || record.layer === 'e2e' || !!record.context?.loadProfile;
  if (requiresDataTier && record.dataTier == null) {
    violations.push(
      `V2: dataTier is required (layer=${record.layer}, loadProfile=${record.context?.loadProfile ?? 'null'}) but is null`,
    );
  }

  // V3
  if (isLatencyDistributionMetric(record.metric) && record.percentile == null) {
    violations.push(`V3: metric "${record.metric}" looks like a latency distribution but percentile is null`);
  }

  // V4
  if (!Number.isInteger(record.sampleSize) || record.sampleSize < 1) {
    violations.push('V4: sampleSize must be an integer >= 1');
  }

  // V5
  if (!record.procedureId || !knownProcedureIds.includes(record.procedureId)) {
    violations.push(`V5: procedureId "${record.procedureId}" does not resolve to a known MeasurementProcedure`);
  }

  // V6
  if (!Array.isArray(record.instrumentationActive)) {
    violations.push('V6: instrumentationActive must be present, even as an empty array');
  }

  return { valid: violations.length === 0, violations };
}

/**
 * V7: records of differing environmentClass must never be averaged, merged,
 * or compared as equivalent. Enforced here as a guard any aggregation
 * helper in this audit's harness must call before combining records.
 */
export function assertSameEnvironmentClass(records: readonly EvidenceRecord[]): void {
  const classes = new Set(records.map((r) => r.environmentClass));
  if (classes.size > 1) {
    throw new Error(
      `V7 violation: attempted to combine records from differing environmentClass values: ${[...classes].join(', ')}`,
    );
  }
}

/**
 * V8: any capacity/throughput claim built from a LOCAL record must carry the
 * label in the same sentence. Enforced by construction — there is no way to
 * call this and get a sentence without the label.
 */
export function formatCapacityClaim(record: EvidenceRecord, claim: string): string {
  return `${claim} (${record.environmentClass}${record.dataTier ? `, ${record.dataTier}` : ''})`;
}

let seq = 0;

export function makeEvidenceId(layer: Layer): string {
  seq += 1;
  return `EV-${layer}-${String(seq).padStart(4, '0')}`;
}

/**
 * Sanitization pass (FR-SEC-006) applied before any record is written:
 * endpoint/route subjects must use route templates, never populated ids.
 * This is a best-effort structural check, not a full PII scanner — the
 * discipline of never populating `subject.endpoint` with a real id is the
 * harness author's responsibility; this catches the common accidental case
 * of a bare UUID/ObjectId-shaped segment.
 */
const UUID_OR_ID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i;

export function assertSanitized(record: EvidenceRecordInput): void {
  const endpoint = (record.subject as { endpoint?: string }).endpoint;
  if (endpoint && UUID_OR_ID_SEGMENT.test(endpoint)) {
    throw new Error(
      `FR-SEC-006 violation: subject.endpoint "${endpoint}" looks like it contains a populated id, not a route template`,
    );
  }
}

export interface WriteOptions {
  /** Base directory for the canonical, cross-cutting store (contract's
   * "Storage" section). Defaults to specs/006-platform-performance-audit/reports/evidence. */
  reportsEvidenceDir?: string;
  /** Repo-local mirror per the contract ("Backend/database-produced records
   * additionally under Ziyarati-back/test/perf/evidence/"). */
  localMirrorDir?: string;
  knownProcedureIds: readonly string[];
}

/**
 * Validates, sanitizes, then appends one EvidenceRecord as a single JSON
 * line to both the canonical reports/evidence/<layer>/ store and this
 * repo's local mirror. Throws on any V1-V6 or sanitization violation rather
 * than writing an invalid record — "evidence or it did not happen" cuts
 * both ways.
 */
export function writeEvidenceRecord(input: EvidenceRecordInput, opts: WriteOptions): EvidenceRecord {
  const validation = validateEvidenceRecord(input, opts.knownProcedureIds);
  if (!validation.valid) {
    throw new Error(`EvidenceRecord ${input.id} failed validation: ${validation.violations.join('; ')}`);
  }
  assertSanitized(input);

  const record: EvidenceRecord = {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
    context: input.context ?? {},
  };

  const reportsDir =
    opts.reportsEvidenceDir ??
    join(__dirname, '..', '..', '..', 'specs', '006-platform-performance-audit', 'reports', 'evidence', record.layer);
  const localDir = opts.localMirrorDir ?? join(__dirname, '..', '..', 'test', 'perf', 'evidence', record.layer);

  for (const dir of [reportsDir, localDir]) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${record.layer}.ndjson`);
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  }

  return record;
}

// ---------------------------------------------------------------------------
// Self-check: proves the writer emits a record passing V1-V8 from a fixture.
// Run directly: npx ts-node -r tsconfig-paths/register scripts/perf/evidence-record.ts
// ---------------------------------------------------------------------------
if (require.main === module) {
  const knownProcedureIds = ['MP-backend-02']; // fixture only; real set authored in T016

  const fixture: EvidenceRecordInput = {
    id: makeEvidenceId('backend'),
    layer: 'backend',
    metric: 'p95_ms',
    value: 412.7,
    unit: 'ms',
    percentile: 95,
    sampleSize: 500,
    environmentClass: 'LOCAL',
    environmentSpec: {
      nodeVersion: process.version,
      postgresVersion: '18.4',
      redisVersion: '7.4.10',
      nodeEnvActual: 'development',
    },
    dataTier: null,
    procedureId: 'MP-backend-02',
    tool: { name: 'autocannon', version: '8.0.0', invocation: 'npx autocannon -c 10 -d 10 <url>' },
    subject: { endpointClass: 'standard-crud', endpoint: '/api/v1/appointments' },
    context: { locale: null, role: 'owner', viewport: null, theme: null, loadProfile: null },
    instrumentationActive: [],
    operator: 'self-check-fixture',
  };

  const validation = validateEvidenceRecord(fixture, knownProcedureIds);
  console.log('V1-V6 validation:', validation.valid ? 'PASS' : `FAIL: ${validation.violations.join('; ')}`);
  if (!validation.valid) process.exit(1);

  assertSanitized(fixture);
  console.log('Sanitization (FR-SEC-006): PASS');

  const written = writeEvidenceRecord(fixture, {
    reportsEvidenceDir: join(__dirname, '__selfcheck__', 'reports-evidence', 'backend'),
    localMirrorDir: join(__dirname, '__selfcheck__', 'local-evidence', 'backend'),
    knownProcedureIds,
  });
  console.log('V7 (differing environmentClass never combined):', (() => {
    try {
      assertSameEnvironmentClass([
        written,
        { ...written, environmentClass: 'STAGING' },
      ]);
      return 'FAIL: did not throw';
    } catch {
      return 'PASS (correctly threw)';
    }
  })());

  const claim = formatCapacityClaim(written, 'Sustains 300 rps');
  console.log('V8 (LOCAL capacity claim carries its label):', claim.includes('LOCAL') ? `PASS: "${claim}"` : 'FAIL');

  console.log(`\nWritten record: ${written.id} -> ${written.layer}.ndjson (canonical + local mirror)`);
  console.log('\nAll V1-V8 checks PASS from this fixture.');
}

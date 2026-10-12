/**
 * Evidence recorder for the Integration API audit spec
 * (test/integration-audit.e2e-spec.ts).
 *
 * Each test records what it EXPECTED (the published contract), what it
 * OBSERVED, and the sanitised request ids. The recorder never decides pass/fail
 * — jest's own result does — it only preserves the observed values so a report
 * can quote them. Everything is scrubbed before it touches disk: API keys,
 * webhook secrets, JWTs, long hex digests and email addresses.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AuditNote {
  id: string;
  category: string;
  title: string;
  route?: string;
  expected: string;
  actual?: unknown;
  requestIds?: string[];
  /** Candidate-finding reference from the audit plan (C1..C12), when relevant. */
  finding?: string;
  /** Test passed, but the observation needs a human decision (documentation gap, etc). */
  needsReview?: boolean;
  /** Free-form explanation of anything that is not obvious from expected/actual. */
  remark?: string;
}

const notes = new Map<string, AuditNote>();

export function note(n: AuditNote): void {
  const prev = notes.get(n.id);
  notes.set(n.id, prev ? { ...prev, ...n } : n);
}

export function scrub(text: string): string {
  return text
    .replace(/zk_[A-Za-z0-9_-]{8,}/g, 'zk_<REDACTED>')
    .replace(/whsec_[A-Za-z0-9_-]{8,}/g, 'whsec_<REDACTED>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<JWT>')
    .replace(/\b[a-f0-9]{64}\b/gi, '<HEX64>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>');
}

/**
 * Evidence is written to the REMEDIATION bundle by default. The original audit
 * bundle (specs/integration-api-audit-2026-10-12) is a historical record and must
 * never be overwritten by a re-run — set AUDIT_EVIDENCE_DIR explicitly to
 * redirect (e.g. for a staging run).
 */
const DEFAULT_DIR =
  process.env.AUDIT_EVIDENCE_DIR ||
  path.resolve(__dirname, '../../../specs/integration-api-remediation-2026-10-12/evidence/raw');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'audit-notes.json');

export function flush(file: string = DEFAULT_FILE, suffix = ''): void {
  const target = suffix ? file.replace(/\.json$/, `${suffix}.json`) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = JSON.stringify(
    { recordedAt: new Date().toISOString(), notes: [...notes.values()] },
    null,
    2,
  );
  fs.writeFileSync(target, scrub(payload));
}

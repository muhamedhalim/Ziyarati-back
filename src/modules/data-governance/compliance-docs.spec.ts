import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_BLOCKS } from './compliance-docs.test-util';
import { processorsMissingEvidence } from './subprocessor-register';

/**
 * Keeps the compliance documents tied to the code registers
 * (residency plan section 19 / 16).
 *
 *  1. Every generated table in infra/docs equals what the register renders now.
 *     Fix a failure with:
 *       UPDATE_COMPLIANCE_DOCS=1 npx jest compliance-docs
 *  2. The production-gate manifest cannot claim a document item that the
 *     register contradicts: `dpa-critical-processors` or `scc-or-alternative`
 *     marked satisfied while a processor still lists that evidence as to-obtain.
 */

const REPO = join(__dirname, '..', '..', '..');
const DOCS = join(REPO, 'infra', 'docs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gate = require(join(REPO, 'infra', 'scripts', 'production-gate.cjs')) as {
  parse(text: string): { items: Array<Record<string, unknown>> };
};

function block(name: string): RegExp {
  return new RegExp(
    `(<!-- BEGIN GENERATED: ${name} -->\\n)([\\s\\S]*?)(\\n<!-- END GENERATED: ${name} -->)`,
  );
}

describe('compliance documents', () => {
  for (const b of GENERATED_BLOCKS) {
    it(`${b.file} block "${b.name}" matches the register`, () => {
      const file = join(DOCS, b.file);
      expect(existsSync(file)).toBe(true);
      const raw = readFileSync(file, 'utf8');
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const text = raw.replace(/\r\n/g, '\n');
      const m = block(b.name).exec(text);
      expect(m).not.toBeNull();
      const expected = b.render();
      if (
        process.env.UPDATE_COMPLIANCE_DOCS === '1' &&
        m &&
        m[2] !== expected
      ) {
        const next = text.replace(
          block(b.name),
          `$1${expected.replace(/\$/g, '$$$$')}$3`,
        );
        writeFileSync(file, next.replace(/\n/g, eol));
        return;
      }
      expect(m && m[2]).toBe(expected);
    });
  }
});

describe('production-gate manifest vs subprocessor register', () => {
  const manifest = gate.parse(
    readFileSync(join(REPO, 'compliance', 'production-gate.yaml'), 'utf8'),
  );
  const status = (id: string): unknown =>
    manifest.items.find((i) => i.id === id)?.status;
  const missing = processorsMissingEvidence();

  it('does not mark DPAs satisfied while a processor still lacks one', () => {
    const lacking = missing.filter((m) => m.missing.includes('dpa'));
    if (status('dpa-critical-processors') === 'satisfied') {
      expect(lacking.map((l) => l.id)).toEqual([]);
    }
  });

  it('does not mark SCCs satisfied while a processor still lacks them', () => {
    const lacking = missing.filter(
      (m) =>
        m.missing.includes('scc') ||
        m.missing.includes('transferRiskAssessment'),
    );
    if (status('scc-or-alternative') === 'satisfied') {
      expect(lacking.map((l) => l.id)).toEqual([]);
    }
  });

  it('does not mark the transfer inventory complete while a subprocessor list is missing', () => {
    const lacking = missing.filter((m) =>
      m.missing.includes('subprocessorList'),
    );
    if (status('transfer-inventory-complete') === 'satisfied') {
      expect(lacking.map((l) => l.id)).toEqual([]);
    }
  });
});

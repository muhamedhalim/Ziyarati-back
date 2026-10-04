import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The Phase 8 CloudWatch alarms are driven by metric filters whose patterns are
 * literal fragments of log lines this code emits
 * (`infra/terraform/modules/monitoring/main.tf`, `payment_log_metrics`). There is
 * no compiler between a log message and an alarm, so rewording a message would
 * silently turn an alarm off. This pins the two together: every term of every
 * filter pattern must still appear, on ONE line, in non-test payments code.
 */
const BACKEND_ROOT = resolve(__dirname, '../../../..');
const MONITORING_TF = join(
  BACKEND_ROOT,
  'infra/terraform/modules/monitoring/main.tf',
);
const SOURCE_DIRS = [
  'src/modules/payments',
  'src/modules/subscription-billing',
  'src/worker',
].map((d) => join(BACKEND_ROOT, d));

function sourceLines(): string[] {
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        lines.push(...readFileSync(full, 'utf8').split(/\r?\n/));
      }
    }
  };
  SOURCE_DIRS.forEach(walk);
  return lines;
}

/** `payment_log_metrics` entries → `{ key, metric, terms[] }`. */
function filterPatterns(): { key: string; metric: string; terms: string[] }[] {
  const tf = readFileSync(MONITORING_TF, 'utf8');
  const block = /payment_log_metrics\s*=\s*\{([\s\S]*?)\n {2}\}/.exec(tf);
  if (!block) throw new Error('payment_log_metrics block not found');
  const entries: { key: string; metric: string; terms: string[] }[] = [];
  const row =
    /^\s*(\w+)\s*=\s*\{\s*pattern\s*=\s*"((?:[^"\\]|\\.)*)",\s*metric\s*=\s*"(\w+)"\s*\}/gm;
  let m: RegExpExecArray | null;
  while ((m = row.exec(block[1]))) {
    // The HCL string holds \"term\" \"term\" — a CloudWatch AND of quoted terms.
    const terms = [...m[2].matchAll(/\\"([^"\\]+)\\"/g)].map((t) => t[1]);
    entries.push({ key: m[1], metric: m[3], terms });
  }
  return entries;
}

describe('Tap CloudWatch alarm log-line contract', () => {
  const entries = existsSync(MONITORING_TF) ? filterPatterns() : [];
  const lines = existsSync(MONITORING_TF) ? sourceLines() : [];

  it('finds the filter table in the monitoring module', () => {
    expect(existsSync(MONITORING_TF)).toBe(true);
    expect(entries.map((e) => e.key).sort()).toEqual(
      [
        'alert',
        'hook_reject',
        'misrouted',
        'no_key',
        'refetch_fail',
        'timeout',
        'unreachable',
      ].sort(),
    );
    for (const e of entries) expect(e.terms.length).toBeGreaterThan(0);
  });

  it.each([
    'alert',
    'hook_reject',
    'misrouted',
    'no_key',
    'refetch_fail',
    'timeout',
    'unreachable',
  ])(
    'a payments log line still carries every term of the "%s" filter',
    (key) => {
      const entry = entries.find((e) => e.key === key);
      expect(entry).toBeDefined();
      const hit = lines.find((l) => entry!.terms.every((t) => l.includes(t)));
      expect({ key, terms: entry!.terms, found: !!hit }).toEqual({
        key,
        terms: entry!.terms,
        found: true,
      });
    },
  );

  it('every metric the alarms read is published by some filter', () => {
    const tf = readFileSync(MONITORING_TF, 'utf8');
    const published = new Set(entries.map((e) => e.metric));
    const read = [
      ...tf.matchAll(
        /ns\s*=\s*"ZiyaraTech\/\$\{var\.environment\}",\s*metric\s*=\s*"(\w+)"/g,
      ),
    ]
      .map((m) => m[1])
      .filter((metric) => /^(Payments|Tap)/.test(metric));
    expect(read.length).toBeGreaterThanOrEqual(7);
    for (const metric of read) expect(published).toContain(metric);
  });
});

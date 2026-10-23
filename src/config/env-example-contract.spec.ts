import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CR-20. `.env.example` is the documented contract of every variable this service reads, and it was
 * git-ignored (the `.gitignore` comment said the opposite), so a fresh clone had no variable list.
 * It must be versionable AND must never carry a real credential.
 */
const ROOT = join(__dirname, '..', '..');

/** Minimal gitignore evaluation for ONE path: last matching pattern wins, `!` re-includes. */
function isIgnored(gitignore: string, path: string): boolean {
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).replace(/^\//, '');
    const re = new RegExp(
      '^' +
        pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') +
        '$',
    );
    if (re.test(path)) ignored = !negated;
  }
  return ignored;
}

describe('CR-20 - .env.example is versioned and placeholder-only', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');

  it('the ignore evaluator behaves (control)', () => {
    expect(isIgnored('.env\n.env.example\n', '.env.example')).toBe(true);
    expect(isIgnored('.env*\n!.env.example\n', '.env.example')).toBe(false);
    expect(isIgnored('.env*\n!.env.example\n', '.env.local')).toBe(true);
  });

  it('.gitignore does not ignore .env.example, but still ignores the real env files', () => {
    expect(isIgnored(gitignore, '.env.example')).toBe(false);
    for (const real of [
      '.env',
      '.env.local',
      '.env.production.local',
      '.env.production',
    ]) {
      expect(isIgnored(gitignore, real)).toBe(true);
    }
  });

  it('every credential-shaped variable in .env.example is empty or an obvious placeholder', () => {
    const file = join(ROOT, '.env.example');
    if (!existsSync(file)) return; // a fresh clone before the file is added; the ignore test above is the gate
    const credentialName =
      /(SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|ACCESS_KEY_ID|VERIFY_TOKEN)$/;
    const placeholder =
      /change|placeholder|example|replace|your|xxx|<|dev|local|test|not-for|dummy|fake|sample|\.\.\./i;
    const offenders: string[] = [];
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!m || !credentialName.test(m[1])) continue;
      const value = m[2].replace(/^["']|["']$/g, '').trim();
      if (value && !placeholder.test(value)) offenders.push(m[1]);
    }
    expect(offenders).toEqual([]);
  });
});

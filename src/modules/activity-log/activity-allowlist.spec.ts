import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTIVITY_VISIBLE_AUDIT_ACTIONS,
  isActivityVisible,
} from './activity-allowlist';

describe('activity-allowlist (T023, FR-U007)', () => {
  it('an unlisted action is invisible — the default is exclusion', () => {
    expect(isActivityVisible('some.brand_new.action_nobody_reviewed')).toBe(
      false,
    );
    expect(isActivityVisible('')).toBe(false);
  });

  it('every listed action is visible', () => {
    for (const action of ACTIVITY_VISIBLE_AUDIT_ACTIONS) {
      expect(isActivityVisible(action)).toBe(true);
    }
  });

  it('the list has no duplicates', () => {
    expect(new Set(ACTIVITY_VISIBLE_AUDIT_ACTIONS).size).toBe(
      ACTIVITY_VISIBLE_AUDIT_ACTIONS.length,
    );
  });

  /**
   * The inverse failure mode to FR-U007's intended one.
   *
   * An action listed here with NO writer anywhere is not a safe default — it
   * is the Activity log promising the clinic a kind of activity it can never
   * actually show. Four such entries (`clinical.entry.created`,
   * `clinical.entry.corrected`, `queue.patient_checked_in`,
   * `waitlist.offer_accepted`) sat here for a full release exactly that way.
   *
   * Scanning the source is deliberate over a hand-maintained second list: a
   * second list would need the same discipline this test exists to enforce.
   */
  describe('every listed action has a writer somewhere in src/', () => {
    const SRC = join(__dirname, '..', '..');

    const sources = (function collect(
      dir: string,
      out: string[] = [],
    ): string[] {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          collect(full, out);
        } else if (
          name.endsWith('.ts') &&
          !name.endsWith('.spec.ts') &&
          // The allow-list itself names every action by definition, and the
          // migrations directory is schema, not a writer.
          full !== join(__dirname, 'activity-allowlist.ts') &&
          !full.includes(join('src', 'migrations'))
        ) {
          out.push(full);
        }
      }
      return out;
    })(SRC);

    const haystack = sources.map((f) => readFileSync(f, 'utf8')).join('\n');

    it.each(ACTIVITY_VISIBLE_AUDIT_ACTIONS)(
      '"%s" is written by production code',
      (action) => {
        expect(haystack).toContain(`'${action}'`);
      },
    );
  });
});

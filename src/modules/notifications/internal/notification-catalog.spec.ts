import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CATALOG_LOCALES,
  MISSING_VARIABLE_PLACEHOLDER,
  NOTIFICATION_CATALOG,
  NOTIFICATION_KEYS,
  isCategoryMutable,
  mutableCategories,
  normalizeVariables,
  preview,
  renderNotification,
  type NotificationEmitContext,
  type NotificationKey,
} from './notification-catalog';
import {
  NOTIFICATION_CATEGORY,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_SCOPE,
  resolveNotificationLocale,
} from './notification-keys';
import { ALL_PERMISSION_SLUGS } from '../../../rbac/rbac.constants';
import type { RecipientPolicy } from './notification-recipient.policy';

/**
 * Catalog invariants.
 *
 * These exist because this codebase already has the failure they prevent: the
 * outbound `CreateNotificationRuleDto` advertises `appointment.missed`,
 * `payment.due` and `subscription.expiring` in its own Swagger description —
 * three events that do not exist anywhere and can never fire, so a clinic
 * configuring one gets a rule that is silently dead forever. Nothing catches
 * that, because a free-form string has nothing to be checked against.
 *
 * A code catalog can be checked, so it is. A malformed entry fails CI rather
 * than shipping as a notification that never arrives.
 */
describe('notification catalog', () => {
  /** Every declared variable, given a value unique enough to find in output. */
  function sentinelVariables(key: NotificationKey): Record<string, string> {
    const spec = NOTIFICATION_CATALOG[key];
    return Object.fromEntries(
      spec.variables.map((name, i) => [name, `«${name}-${i}»`]),
    );
  }

  function fullContext(key: NotificationKey): NotificationEmitContext {
    return {
      tenantId: 'aaaaaaaa-0000-4000-8000-000000000001',
      actorUserId: 'bbbbbbbb-0000-4000-8000-000000000002',
      variables: sentinelVariables(key),
      // Every ref a spec might read. Supplying all of them means a spec that
      // reads one this test does not know about still fails loudly (its dedupe
      // or link comes back null) rather than passing on a coincidence.
      refs: {
        ticketId: 'cccccccc-0000-4000-8000-000000000003',
        eventId: 'dddddddd-0000-4000-8000-000000000004',
      },
    };
  }

  it('declares at least one notification', () => {
    expect(NOTIFICATION_KEYS.length).toBeGreaterThan(0);
  });

  it.each(NOTIFICATION_KEYS)('%s renders in every supported locale', (key) => {
    const vars = sentinelVariables(key);

    for (const locale of CATALOG_LOCALES) {
      const { title, body } = renderNotification(key, locale, vars);

      expect(title.trim()).not.toHaveLength(0);
      expect(body.trim()).not.toHaveLength(0);

      // The three ways a broken renderer leaks through to a user.
      for (const rendered of [title, body]) {
        expect(rendered).not.toContain('undefined');
        expect(rendered).not.toContain('[object Object]');
        expect(rendered).not.toContain('{{');
      }
    }
  });

  /**
   * Removes the interpolated values, leaving only the literal text a translator
   * is responsible for.
   *
   * This distinction is the whole point of the test below. A string like
   * `"SUP-000123: Cannot load calendar"` is pure interpolation — a ticket
   * number and a user-authored subject — and is CORRECTLY identical in every
   * language. Comparing whole rendered strings would flag it as untranslated
   * and push someone to invent Arabic prose around data that needs none.
   */
  const literalsOnly = (text: string): string =>
    text.replace(/«[^»]*»/g, '').trim();

  it.each(NOTIFICATION_KEYS)(
    '%s translates all of its literal prose',
    (key) => {
      const vars = sentinelVariables(key);
      const en = renderNotification(key, 'en', vars);
      const ar = renderNotification(key, 'ar', vars);

      // Titles always carry prose, so they must always differ. This catches the
      // copy-paste failure where `ar` was filled in with the English string —
      // which type-checks, renders, and is still untranslated.
      expect(literalsOnly(ar.title)).not.toEqual(literalsOnly(en.title));

      // Bodies only when they contain literal words at all.
      if (/[A-Za-z]/.test(literalsOnly(en.body))) {
        expect(literalsOnly(ar.body)).not.toEqual(literalsOnly(en.body));
      }

      // Whatever prose the Arabic side does carry must actually be Arabic —
      // a Latin-script "translation" would slip past the inequality check.
      const arabicProse = `${literalsOnly(ar.title)} ${literalsOnly(ar.body)}`;
      expect(arabicProse).toMatch(/[؀-ۿ]/);
      // ...and must not have kept English words alongside it.
      expect(arabicProse).not.toMatch(/[A-Za-z]{3,}/);
    },
  );

  it.each(NOTIFICATION_KEYS)(
    '%s uses every variable it declares, in both locales',
    (key) => {
      const spec = NOTIFICATION_CATALOG[key];
      const vars = sentinelVariables(key);

      for (const locale of CATALOG_LOCALES) {
        const { title, body } = renderNotification(key, locale, vars);
        const rendered = `${title}\n${body}`;
        for (const name of spec.variables) {
          // An unused declared variable means either dead weight in the spec or
          // — worse — a producer computing something the reader never sees.
          // Values that steer `dedupe`/`link` belong in `refs`, not `variables`.
          expect(rendered).toContain(vars[name]);
        }
      }
    },
  );

  it.each(NOTIFICATION_KEYS)(
    '%s degrades to a placeholder when the producer supplies nothing',
    (key) => {
      for (const locale of CATALOG_LOCALES) {
        const { title, body } = renderNotification(key, locale, {});
        expect(title.trim()).not.toHaveLength(0);
        expect(`${title} ${body}`).not.toContain('undefined');
      }
      // And the placeholder is the documented one, not an empty gap.
      const spec = NOTIFICATION_CATALOG[key];
      if (spec.variables.length > 0) {
        const normalized = normalizeVariables(spec, {});
        expect(Object.values(normalized)).toContain(
          MISSING_VARIABLE_PLACEHOLDER,
        );
      }
    },
  );

  it.each(NOTIFICATION_KEYS)('%s has a valid priority', (key) => {
    expect(NOTIFICATION_PRIORITIES).toContain(
      NOTIFICATION_CATALOG[key].priority,
    );
  });

  it.each(NOTIFICATION_KEYS)(
    '%s targets a recipient policy consistent with its scope',
    (key) => {
      const spec = NOTIFICATION_CATALOG[key];

      // A TENANT_PERMISSION policy on a PLATFORM notification (or the reverse)
      // is refused at runtime by the resolver and would silently notify nobody.
      const assertCoherent = (policy: RecipientPolicy): void => {
        switch (policy.kind) {
          case 'TENANT_PERMISSION':
            expect(spec.scope).toBe(NOTIFICATION_SCOPE.TENANT);
            expect(ALL_PERMISSION_SLUGS).toContain(policy.permission);
            break;
          case 'PLATFORM_PERMISSION':
            expect(spec.scope).toBe(NOTIFICATION_SCOPE.PLATFORM);
            expect(ALL_PERMISSION_SLUGS).toContain(policy.permission);
            break;
          case 'SPECIFIC_USERS':
            break;
          case 'UNION':
            policy.policies.forEach(assertCoherent);
            break;
        }
      };

      assertCoherent(spec.recipients);
    },
  );

  it.each(NOTIFICATION_KEYS)(
    '%s produces a dedupe key from a complete context',
    (key) => {
      const dedupe = NOTIFICATION_CATALOG[key].dedupe(fullContext(key));
      // Null is allowed in the type (a genuinely un-dedupable notification),
      // but every key shipped so far is dedupable — and one that silently
      // stopped being so would reintroduce duplicate-on-replay.
      expect(typeof dedupe).toBe('string');
      expect(dedupe).not.toHaveLength(0);
    },
  );

  it.each(NOTIFICATION_KEYS)(
    '%s links to a relative in-app path',
    (key) => {
      const link = NOTIFICATION_CATALOG[key].link(fullContext(key));
      expect(link).toBeTruthy();
      // Relative only: the frontend owns the origin and the /{locale} prefix.
      // An absolute URL here would also be an open-redirect surface.
      expect(link!.startsWith('/')).toBe(true);
      expect(link).not.toMatch(/^https?:/i);
      expect(link!.startsWith('//')).toBe(false);
    },
  );

  it.each(NOTIFICATION_KEYS)(
    '%s still links somewhere when its refs are missing',
    (key) => {
      const link = NOTIFICATION_CATALOG[key].link({ tenantId: null });
      // A notification whose link resolved to `/undefined` would be worse than
      // one with no link at all.
      expect(link === null || link.startsWith('/')).toBe(true);
      expect(link ?? '').not.toContain('undefined');
      expect(link ?? '').not.toContain('null');
    },
  );

  it('marks every SECURITY notification mandatory', () => {
    // Widened deliberately: the catalog currently declares only SUPPORT keys,
    // so TypeScript narrows `category` to that single literal and rejects the
    // comparison as impossible. This assertion exists to hold the line when
    // Phase 2 adds the SECURITY family, so it must survive the interim.
    const securityKeys = NOTIFICATION_KEYS.filter(
      (k) =>
        (NOTIFICATION_CATALOG[k].category as string) ===
        NOTIFICATION_CATEGORY.SECURITY,
    );
    for (const key of securityKeys) {
      expect(NOTIFICATION_CATALOG[key].mandatory).toBe(true);
    }
    // And therefore that the category cannot be muted.
    if (securityKeys.length > 0) {
      expect(isCategoryMutable(NOTIFICATION_CATEGORY.SECURITY)).toBe(false);
      expect(mutableCategories()).not.toContain(
        NOTIFICATION_CATEGORY.SECURITY,
      );
    }
  });

  /**
   * The anti-orphan check.
   *
   * A catalog entry nothing ever emits is the exact shape of the existing bug
   * this system replaces: configuration that looks live and never fires. Every
   * key must be referenced by the listener, which is the only thing that emits.
   */
  it('emits every key it declares — no orphaned catalog entries', () => {
    const listener = readFileSync(
      join(__dirname, 'internal-notification.listener.ts'),
      'utf8',
    );
    const orphans = NOTIFICATION_KEYS.filter(
      (key) => !listener.includes(`'${key}'`),
    );
    expect(orphans).toEqual([]);
  });

  describe('preview()', () => {
    it('collapses whitespace so a multi-line reply stays one line', () => {
      expect(preview('hello\n\n  world\t!')).toBe('hello world !');
    });

    it('truncates a long body rather than storing all of it', () => {
      const long = 'x'.repeat(500);
      const result = preview(long);
      expect(result.length).toBeLessThanOrEqual(140);
      expect(result.endsWith('…')).toBe(true);
    });

    it('returns an empty string for nothing at all', () => {
      expect(preview(null)).toBe('');
      expect(preview(undefined)).toBe('');
      expect(preview('   ')).toBe('');
    });
  });

  describe('renderNotification() fallbacks', () => {
    it('renders a retired key as a neutral placeholder instead of throwing', () => {
      // An old row whose key was later renamed must not take down the whole
      // inbox response for that user.
      const rendered = renderNotification('SOME_RETIRED_KEY', 'en', {});
      expect(rendered.title).toBe('SOME_RETIRED_KEY');
      expect(rendered.body).toBe('');
    });

    it('falls back to English for a locale with no renderer', () => {
      const key = NOTIFICATION_KEYS[0];
      const vars = sentinelVariables(key);
      const rendered = renderNotification(key, 'fr' as never, vars);
      expect(rendered.title).toEqual(renderNotification(key, 'en', vars).title);
    });
  });

  describe('resolveNotificationLocale()', () => {
    it.each([
      ['ar', 'ar'],
      ['ar-SA', 'ar'],
      ['AR', 'ar'],
      ['ar_EG', 'ar'],
      ['en-GB', 'en'],
      ['en', 'en'],
    ])('normalizes %s to %s', (input, expected) => {
      expect(resolveNotificationLocale(input)).toBe(expected);
    });

    it.each([null, undefined, '', '   ', 'fr', 'zz-ZZ'])(
      'falls back to English for %p',
      (input) => {
        expect(resolveNotificationLocale(input as string | null)).toBe('en');
      },
    );
  });

  describe('normalizeVariables()', () => {
    const spec = NOTIFICATION_CATALOG[NOTIFICATION_KEYS[0]];

    it('drops values the spec did not declare', () => {
      const out = normalizeVariables(spec, { notDeclared: 'leak' });
      expect(Object.keys(out)).toEqual([...spec.variables]);
      expect(Object.values(out)).not.toContain('leak');
    });

    it('renders empty and non-finite values as the placeholder', () => {
      const first = spec.variables[0];
      expect(normalizeVariables(spec, { [first]: '  ' })[first]).toBe(
        MISSING_VARIABLE_PLACEHOLDER,
      );
      expect(normalizeVariables(spec, { [first]: NaN })[first]).toBe(
        MISSING_VARIABLE_PLACEHOLDER,
      );
      expect(
        normalizeVariables(spec, { [first]: new Date('nope') })[first],
      ).toBe(MISSING_VARIABLE_PLACEHOLDER);
    });

    it('keeps a zero, which is a real value and not a missing one', () => {
      const first = spec.variables[0];
      expect(normalizeVariables(spec, { [first]: 0 })[first]).toBe('0');
    });
  });
});

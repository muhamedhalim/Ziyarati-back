import {
  assertScopesGrantable,
  normalizeScopes,
  INTEGRATION_SCOPE,
  INTEGRATION_SCOPES,
  INTEGRATION_SCOPE_REQUIRES,
} from './integration-scopes.constants';
import { PERMISSION } from '../../rbac/rbac.constants';
import { ErrorCode } from '../../common/errors';

describe('integration-scopes.constants', () => {
  it('never reuses an internal RBAC permission slug as a scope value', () => {
    const internalSlugs = new Set(Object.values(PERMISSION));
    for (const scope of INTEGRATION_SCOPES) {
      expect(internalSlugs.has(scope as never)).toBe(false);
      expect(scope.startsWith('integration.')).toBe(true);
    }
  });

  it('maps every scope to a real internal permission slug', () => {
    for (const scope of INTEGRATION_SCOPES) {
      expect(Object.values(PERMISSION)).toContain(INTEGRATION_SCOPE_REQUIRES[scope]);
    }
  });

  describe('normalizeScopes', () => {
    it('filters to recognised scope strings only', () => {
      expect(
        normalizeScopes([INTEGRATION_SCOPE.SERVICES_READ, 'junk', 123, null, undefined]),
      ).toEqual([INTEGRATION_SCOPE.SERVICES_READ]);
    });

    it('returns [] for non-array input', () => {
      expect(normalizeScopes(null)).toEqual([]);
      expect(normalizeScopes(undefined)).toEqual([]);
      expect(normalizeScopes('not-an-array')).toEqual([]);
    });
  });

  describe('assertScopesGrantable', () => {
    it('allows an empty/undefined request', () => {
      expect(() => assertScopesGrantable(undefined, [], false)).not.toThrow();
      expect(() => assertScopesGrantable([], [], false)).not.toThrow();
    });

    it('allows a scope when the caller holds its required internal permission', () => {
      expect(() =>
        assertScopesGrantable(
          [INTEGRATION_SCOPE.SERVICES_READ],
          [PERMISSION.SERVICES_READ],
          false,
        ),
      ).not.toThrow();
    });

    it('rejects a scope the caller does not hold the required internal permission for', () => {
      expect(() =>
        assertScopesGrantable([INTEGRATION_SCOPE.CUSTOMERS_READ], [PERMISSION.SERVICES_READ], false),
      ).toThrow(expect.objectContaining({ code: ErrorCode.FORBIDDEN }));
    });

    it('rejects an unrecognised scope string outright', () => {
      expect(() =>
        assertScopesGrantable(['services.read' /* raw internal slug, not a scope */], [PERMISSION.SERVICES_READ], false),
      ).toThrow(expect.objectContaining({ code: ErrorCode.FORBIDDEN }));
    });

    it('super_admin may grant any scope regardless of held permissions', () => {
      expect(() =>
        assertScopesGrantable([INTEGRATION_SCOPE.APPOINTMENTS_READ], [], true),
      ).not.toThrow();
    });
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateApiKeyDto } from './dto/create-api-key.dto';
import {
  TENANT_GRANTABLE_SCOPES,
  assertScopesGrantable,
  normalizeScopes,
  INTEGRATION_SCOPE,
  INTEGRATION_SCOPES,
  INTEGRATION_SCOPE_REQUIRES,
} from './integration-scopes.constants';
import { PERMISSION } from '../../rbac/rbac.constants';
import { ErrorCode } from '../../common/errors';

// Contract C11 (Marketplace) — `marketplace:discovery` is deliberately a
// different KIND of scope from every `integration.*` one: it grants no
// tenant data access at all (it only elevates public discovery throttling
// for a platform-level key), so it has no tenant-held permission to map to
// and does not follow the `integration.` naming convention that signals
// "tenant-scoped integration privilege". It is excluded from the two
// blanket assertions below by name, with its own dedicated assertions
// immediately after — never silently swept into either loop.
const TENANT_SCOPED_ONLY = INTEGRATION_SCOPES.filter(
  (s) => s !== INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY,
);

describe('integration-scopes.constants', () => {
  it('never reuses an internal RBAC permission slug as a scope value (tenant-scoped integration scopes)', () => {
    const internalSlugs = new Set(Object.values(PERMISSION));
    for (const scope of TENANT_SCOPED_ONLY) {
      expect(internalSlugs.has(scope as never)).toBe(false);
      expect(scope.startsWith('integration.')).toBe(true);
    }
  });

  it('maps every tenant-scoped integration scope to a real internal permission slug', () => {
    for (const scope of TENANT_SCOPED_ONLY) {
      expect(Object.values(PERMISSION)).toContain(INTEGRATION_SCOPE_REQUIRES[scope]);
    }
  });

  it('marketplace:discovery is namespaced outside integration.* and has NO permission mapping (contract C11)', () => {
    expect(INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY.startsWith('integration.')).toBe(false);
    expect(INTEGRATION_SCOPE_REQUIRES[INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY]).toBeUndefined();
  });

  it('marketplace:discovery can never be granted through the ordinary tenant-scoped grant check, even by a caller with every permission', () => {
    const everyPermission = Object.values(PERMISSION);
    expect(() =>
      assertScopesGrantable([INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY], everyPermission, false),
    ).toThrow(expect.objectContaining({ code: ErrorCode.FORBIDDEN }));
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

describe('SEC-11 — tenant-issued keys can never carry the platform-level scope', () => {
  it('TENANT_GRANTABLE_SCOPES is exactly every scope that has a required permission', () => {
    expect(TENANT_GRANTABLE_SCOPES).not.toContain(INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY);
    expect([...TENANT_GRANTABLE_SCOPES].sort()).toEqual([...TENANT_SCOPED_ONLY].sort());
  });

  it('the create-key DTO rejects marketplace:discovery even though a super-admin could otherwise grant it', async () => {
    const dto = plainToInstance(CreateApiKeyDto, {
      permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY],
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('permissions');
  });

  it('the create-key DTO still accepts every tenant scope', async () => {
    const dto = plainToInstance(CreateApiKeyDto, { permissions: [...TENANT_GRANTABLE_SCOPES] });
    expect(await validate(dto)).toEqual([]);
  });
});

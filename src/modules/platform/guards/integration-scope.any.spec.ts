import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import { IntegrationScopeGuard } from './integration-scope.guard';
import { REQUIRE_ANY_SCOPE_KEY, REQUIRE_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import { INTEGRATION_SCOPE } from '../integration-scopes.constants';
import { ErrorCode } from '../../../common/errors';

function ctx(permissions: string[] | null, meta: { all?: string[]; any?: string[] }): [IntegrationScopeGuard, ExecutionContext] {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === REQUIRE_SCOPES_KEY ? meta.all : key === REQUIRE_ANY_SCOPE_KEY ? meta.any : undefined,
    ),
  } as unknown as Reflector;
  const guard = new IntegrationScopeGuard(reflector);
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: permissions ? { permissions } : undefined }) }),
  } as unknown as ExecutionContext;
  return [guard, context];
}

const ANY = [
  INTEGRATION_SCOPE.AVAILABILITY_READ,
  INTEGRATION_SCOPE.APPOINTMENTS_READ,
  INTEGRATION_SCOPE.APPOINTMENTS_WRITE,
];

describe('IntegrationScopeGuard — any-of scopes (branch discovery, F05)', () => {
  it.each(ANY)('passes with just %s', (scope) => {
    const [g, c] = ctx([scope], { all: [], any: ANY });
    expect(g.canActivate(c)).toBe(true);
  });

  it('refuses a key holding none of them (403), even with unrelated scopes', () => {
    const [g, c] = ctx([INTEGRATION_SCOPE.CUSTOMERS_READ, INTEGRATION_SCOPE.SERVICES_WRITE], { all: [], any: ANY });
    expect(() => g.canActivate(c)).toThrow(expect.objectContaining({ code: ErrorCode.FORBIDDEN }));
  });

  it('refuses a request without a principal (401)', () => {
    const [g, c] = ctx(null, { all: [], any: ANY });
    expect(() => g.canActivate(c)).toThrow(expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }));
  });

  it('still enforces all-of scopes when both are declared', () => {
    const meta = { all: [INTEGRATION_SCOPE.CUSTOMERS_READ], any: ANY };
    const [g1, c1] = ctx([INTEGRATION_SCOPE.AVAILABILITY_READ], meta);
    expect(() => g1.canActivate(c1)).toThrow();
    const [g2, c2] = ctx([INTEGRATION_SCOPE.AVAILABILITY_READ, INTEGRATION_SCOPE.CUSTOMERS_READ], meta);
    expect(g2.canActivate(c2)).toBe(true);
  });

  it('a route with no scope metadata is unchanged (open to any authenticated key)', () => {
    const [g, c] = ctx([], {});
    expect(g.canActivate(c)).toBe(true);
  });
});

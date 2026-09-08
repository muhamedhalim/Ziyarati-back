import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reflector } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';

import { PlatformSpecialtiesService } from './platform-specialties.service';
import { PlatformSpecialtiesController } from './platform-specialties.controller';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/** Contract C9. Validate: unauthorized callers refused; assertions survive re-derivation. */

function makeQueryMock(responses: Array<[RegExp, unknown]> = []) {
  return jest.fn(async (sql: string) => {
    for (const [pattern, result] of responses) {
      if (pattern.test(sql)) return result;
    }
    return [{ tenantId: 't-1' }]; // default: existence checks pass
  });
}

function makeContext(user: { roles: string[] } | undefined) {
  return {
    getHandler: () =>
      PlatformSpecialtiesController.prototype.assertTenantSpecialty,
    getClass: () => PlatformSpecialtiesController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

describe('PlatformSpecialtiesController — RolesGuard (unauthorized callers refused)', () => {
  it('refuses a caller with no roles at all', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(makeContext(undefined))).toThrow();
  });

  it('refuses an authenticated caller who is not super_admin', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() =>
      guard.canActivate(makeContext({ roles: [ROLE.BRANCH_MANAGER] })),
    ).toThrow();
  });

  it('admits a super_admin caller', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(makeContext({ roles: [ROLE.SUPER_ADMIN] }))).toBe(
      true,
    );
  });
});

describe('PlatformSpecialtiesService.assertTenantSpecialty (assertions survive re-derivation)', () => {
  it('upserts to ASSERTED — a human correction always wins over a later re-derivation', async () => {
    const query = makeQueryMock();
    const audit = { record: jest.fn() };
    const tenantContext = { getUser: () => ({ id: 'admin-1' }) };
    const service = new PlatformSpecialtiesService(
      { query } as any,
      tenantContext as any,
      audit as any,
    );

    await service.assertTenantSpecialty('tenant-1', 'specialty-1');

    const insertCall = query.mock.calls.find(([sql]) =>
      /INSERT INTO "tenant_specialties"/.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [sql] = insertCall!;
    expect(sql).toMatch(/'ASSERTED'::tenant_specialty_provenance_enum/);
    expect(sql).toMatch(/ON CONFLICT \("tenantId", "specialtyId"\)/);
    expect(sql).toMatch(/DO UPDATE SET "provenance" = 'ASSERTED'/);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.stringContaining('specialty.tenant_assert'),
      }),
    );
  });

  it('the backfill migration can never flip an ASSERTED row back — it only INSERTs DERIVED and ON CONFLICT DO NOTHINGs', async () => {
    // Structural proof, not a duplicate DB run: assert() upserts the row to
    // ASSERTED unconditionally (DO UPDATE), while the backfill migration
    // (T054, verified live against a real database) only ever INSERTs
    // 'DERIVED' with ON CONFLICT DO NOTHING — it has no UPDATE branch at
    // all, so it structurally cannot downgrade a row this service wrote.
    const backfillSource = readFileSync(
      join(
        __dirname,
        '../../migrations/1730095000000-MarketplaceSpecialtiesBackfill.ts',
      ),
      'utf8',
    );
    expect(backfillSource).toMatch(
      /ON CONFLICT \("tenantId", "specialtyId"\) DO NOTHING/,
    );
    expect(backfillSource).not.toMatch(/tenant_specialties[\s\S]*?DO UPDATE/);
  });

  it('rejects assertion for an unknown tenant', async () => {
    const query = jest.fn(async (sql: string) =>
      /FROM "tenants"/.test(sql) ? [] : [{ tenantId: 't-1' }],
    );
    const service = new PlatformSpecialtiesService(
      { query } as any,
      { getUser: () => ({ id: 'admin-1' }) } as any,
      { record: jest.fn() } as any,
    );
    await expect(
      service.assertTenantSpecialty('nope', 'specialty-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

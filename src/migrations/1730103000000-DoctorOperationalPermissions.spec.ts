import { DoctorOperationalPermissions1730103000000 as Migration } from './1730103000000-DoctorOperationalPermissions';
import {
  PERMISSION,
  PERMISSIONS,
  ROLE,
  ROLE_PERMISSIONS,
  ROLES,
} from '../rbac/rbac.constants';
import { getPermissionMetadata } from '../rbac/permission-metadata';

const sqlOf = async (
  run: (q: { query: jest.Mock }) => Promise<void>,
  responses: unknown[] = [],
) => {
  const query = jest.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  query.mockResolvedValue([]);
  await run({ query } as never);
  return query.mock.calls.map(([statement, params]) => ({
    statement: statement as string,
    params,
  }));
};

const DOCTOR_SLUGS = [
  'dashboard.access',
  'appointments.read_own',
  'crm.customers.read',
  'clinical.records.read',
  'clinical.records.manage',
  'staff.read_own',
  'appointments.status.update',
  'crm.notes.read',
  'crm.tags.read',
  'crm.files.read',
  'crm.customers.update_own',
  'staff.schedule.read',
];

describe('DoctorOperationalPermissions migration', () => {
  // 1 role insert + 12 permission inserts + 12 grant inserts + 1 verify = 26.
  const CLEAN_RUN = [
    [], // 0: role insert
    ...Array.from({ length: 12 }, () => []), // 1-12: permission inserts
    ...Array.from({ length: 12 }, () => []), // 13-24: grant inserts
    [{ c: 0 }], // 25: verification SELECT — nothing missing
  ];

  const up = (responses: unknown[] = CLEAN_RUN) =>
    sqlOf((q) => new Migration().up(q as never), responses);
  const down = (responses: unknown[] = []) =>
    sqlOf((q) => new Migration().down(q as never), responses);

  it('has a class name and `name` property that agree (TypeORM keys migrations on `name`)', () => {
    expect(new Migration().name).toBe(
      'DoctorOperationalPermissions1730103000000',
    );
  });

  describe('up()', () => {
    it('seeds the global doctor role row, guarded by NOT EXISTS, with the exact ROLES text', async () => {
      const calls = await up();
      const doctorRole = ROLES.find((r) => r.slug === ROLE.DOCTOR);

      expect(calls[0].statement).toContain('INSERT INTO "roles"');
      expect(calls[0].statement).toContain('NOT EXISTS');
      expect(calls[0].statement).toContain('"tenantId" IS NULL');
      expect(calls[0].params).toEqual([
        doctorRole?.name,
        'doctor',
        doctorRole?.description,
      ]);
    });

    it('seeds exactly the 12 doctor permission rows, ON CONFLICT DO NOTHING', async () => {
      const calls = await up();
      const permCalls = calls.slice(1, 13);

      expect(permCalls).toHaveLength(12);
      for (const call of permCalls) {
        expect(call.statement).toContain('INSERT INTO "permissions"');
        expect(call.statement).toContain('ON CONFLICT (slug) DO NOTHING');
      }
      const slugs = permCalls.map((c) => (c.params as unknown[])[1]);
      expect([...slugs].sort()).toEqual([...DOCTOR_SLUGS].sort());
    });

    it('grants exactly the 12 doctor permissions to the GLOBAL doctor role, each existence-checked (idempotent on re-run)', async () => {
      const calls = await up();
      const grantCalls = calls.slice(13, 25);

      expect(grantCalls).toHaveLength(12);
      for (const call of grantCalls) {
        expect(call.statement).toContain('INSERT INTO "role_permissions"');
        expect(call.statement).toContain('NOT EXISTS');
        expect(call.statement).toContain('r."tenantId" IS NULL');
        expect((call.params as [string, string])[0]).toBe('doctor');
      }
      const slugs = grantCalls.map((c) => (c.params as [string, string])[1]);
      expect([...slugs].sort()).toEqual([...DOCTOR_SLUGS].sort());
    });

    it('never grants a tenant-wide appointment write, a manage slug, or anything administrative', async () => {
      const calls = await up();
      const granted = calls
        .slice(13, 25)
        .map((c) => (c.params as [string, string])[1]);

      for (const forbidden of [
        'appointments.update',
        'appointments.read',
        'appointments.create',
        'appointments.cancel',
        'appointments.reschedule',
        'crm.customers.manage',
        'crm.notes.manage',
        'crm.files.manage',
        'crm.tags.manage',
        'staff.read',
        'staff.schedule.manage',
        'branches.update',
        'branches.update_own',
        'clinical.records.nursing',
      ]) {
        expect(granted).not.toContain(forbidden);
      }
    });

    it('verifies every expected grant landed, against the GLOBAL doctor role', async () => {
      const calls = await up();
      const verify = calls[25];

      expect(verify.statement).toContain('unnest($1::text[])');
      expect(verify.statement).toContain('"tenantId" IS NULL');
      expect((verify.params as [string[], string])[1]).toBe('doctor');
      expect([...(verify.params as [string[], string])[0]].sort()).toEqual(
        [...DOCTOR_SLUGS].sort(),
      );
    });

    it('aborts if any expected grant is still missing after the insert loop', async () => {
      const responses = [...CLEAN_RUN.slice(0, -1), [{ c: 3 }]];
      await expect(up(responses)).rejects.toThrow(
        /3 of 12 expected grant\(s\) are still missing/,
      );
    });

    it('never DELETEs or UPDATEs anything — it only ever adds', async () => {
      const calls = await up();
      for (const call of calls) {
        expect(call.statement).not.toMatch(/\bDELETE\b/i);
        expect(call.statement).not.toMatch(/\bUPDATE\b/i);
      }
    });
  });

  describe('down()', () => {
    it('removes ONLY the doctor’s grant for the four pre-existing slugs it newly assigned — leaving the permission rows for the nurse and others', async () => {
      const calls = await down();
      const doctorOnly = calls.filter(
        (c) =>
          c.statement.includes('DELETE FROM "role_permissions"') &&
          c.statement.includes('r.slug = $1'),
      );

      expect(doctorOnly.map((c) => (c.params as string[])[1]).sort()).toEqual(
        [
          'appointments.status.update',
          'crm.files.read',
          'crm.notes.read',
          'crm.tags.read',
        ].sort(),
      );
      for (const call of doctorOnly) {
        expect((call.params as string[])[0]).toBe('doctor');
      }
      // The four permission rows themselves are never deleted.
      const permissionRowDeletes = calls
        .filter((c) => c.statement.includes('DELETE FROM "permissions"'))
        .map((c) => (c.params as string[])[0]);
      for (const slug of [
        'appointments.status.update',
        'crm.notes.read',
        'crm.tags.read',
        'crm.files.read',
      ]) {
        expect(permissionRowDeletes).not.toContain(slug);
      }
    });

    it('fully retires the two slugs it created: strips their grants from EVERY role first, then deletes the permission rows', async () => {
      const calls = await down();

      for (const slug of ['crm.customers.update_own', 'staff.schedule.read']) {
        const stripIdx = calls.findIndex(
          (c) =>
            c.statement.includes('DELETE FROM "role_permissions"') &&
            !c.statement.includes('r.slug') &&
            (c.params as string[])[0] === slug,
        );
        const rowIdx = calls.findIndex(
          (c) =>
            c.statement.includes('DELETE FROM "permissions"') &&
            (c.params as string[])[0] === slug,
        );
        expect(stripIdx).toBeGreaterThanOrEqual(0);
        expect(rowIdx).toBeGreaterThan(stripIdx);
      }
    });

    it('never touches the doctor’s original six grants and never deletes the doctor role', async () => {
      const calls = await down();
      const touched = calls.flatMap(
        (c) => (c.params as string[] | undefined) ?? [],
      );

      for (const original of [
        'dashboard.access',
        'appointments.read_own',
        'crm.customers.read',
        'clinical.records.read',
        'clinical.records.manage',
        'staff.read_own',
      ]) {
        expect(touched).not.toContain(original);
      }
      expect(
        calls.some((c) => c.statement.includes('DELETE FROM "roles"')),
      ).toBe(false);
    });
  });

  /**
   * The frozen snapshot must equal what the boot-time seeders would write, or
   * a seed-enabled environment reconciles (rewrites) rows this migration made,
   * and a production database would silently disagree with dev/e2e.
   */
  describe('parity with the live constants (seeder ⇄ migration)', () => {
    const grants = (
      Migration as unknown as {
        GRANTS: ReadonlyArray<{
          slug: string;
          name: string;
          module: string;
          scope: string;
          risk: string;
          description: string | null;
        }>;
      }
    ).GRANTS;

    it('grants exactly what ROLE_PERMISSIONS[doctor] holds — no more, no less', () => {
      expect(grants.map((g) => g.slug).sort()).toEqual(
        [...(ROLE_PERMISSIONS[ROLE.DOCTOR] as string[])].sort(),
      );
    });

    it.each(grants.map((g) => [g.slug, g] as const))(
      '%s: name and module equal the PERMISSIONS catalogue',
      (_slug, g) => {
        const def = PERMISSIONS.find((p) => p.slug === g.slug);
        expect(def).toBeDefined();
        expect(g.name).toBe(def?.name);
        expect(g.module).toBe(def?.module);
      },
    );

    it.each(grants.map((g) => [g.slug, g] as const))(
      '%s: scope and risk equal permission-metadata (so seedPermissions finds nothing to change)',
      (slug, g) => {
        const meta = getPermissionMetadata(slug as never);
        expect(g.scope).toBe(meta.scope);
        expect(g.risk).toBe(meta.risk);
      },
    );

    it('the two NEW slugs carry the EXACT metadata description — they are inserted by this migration and nothing else', () => {
      for (const slug of [
        PERMISSION.CRM_CUSTOMERS_UPDATE_OWN,
        PERMISSION.STAFF_SCHEDULE_READ,
      ]) {
        const g = grants.find((x) => x.slug === slug);
        expect(g?.description).toBe(getPermissionMetadata(slug).description);
        expect(g?.description).toBeTruthy();
      }
    });

    it('the role text equals the ROLES catalogue, so seedRoles finds nothing to reconcile', () => {
      const m = Migration as unknown as {
        ROLE_NAME: string;
        ROLE_DESCRIPTION: string;
      };
      const def = ROLES.find((r) => r.slug === ROLE.DOCTOR);
      expect(m.ROLE_NAME).toBe(def?.name);
      expect(m.ROLE_DESCRIPTION).toBe(def?.description);
    });
  });
});

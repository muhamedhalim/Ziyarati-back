import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { slugify, uniqueSlug } from '../../common/utils/slugify.util';
import { StaffService } from './staff.service';
import { StaffPublicSlug1730096000000 } from '../../migrations/1730096000000-StaffPublicSlug';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Service } from '../../entities/Services/Service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { AuthService } from '../auth/auth.service';
import { RolesService } from '../auth/roles.service';
import { StaffAccessService } from './staff-access.service';
import { StorageService } from '../storage/storage.service';
import { UsageService } from '../subscription-billing/usage.service';
import { EmailService } from '../email/email.service';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('slugify (Marketplace BE-2, T060)', () => {
  it('lowercases, kebab-cases, and strips punctuation from a Latin name', () => {
    expect(slugify('Dr. Ahmed Ali')).toBe('dr-ahmed-ali');
  });

  it('keeps an Arabic-only name legible instead of falling back (Unicode-aware)', () => {
    expect(slugify('د. خالد العتيبي')).toMatch(/[؀-ۿ]/);
    expect(slugify('د. خالد العتيبي')).not.toBe('doctor');
  });

  it('falls back to the given default when the input has no letters/digits at all', () => {
    expect(slugify('   ', 'doctor')).toBe('doctor');
    expect(slugify('', 'doctor')).toBe('doctor');
  });
});

describe('uniqueSlug (deterministic numeric disambiguation)', () => {
  it('returns the base slug when it is free', async () => {
    await expect(uniqueSlug('dr-ahmed-ali', () => false)).resolves.toBe(
      'dr-ahmed-ali',
    );
  });

  it('appends -2, -3, ... deterministically until a free candidate is found', async () => {
    const taken = new Set(['dr-ahmed-ali', 'dr-ahmed-ali-2', 'dr-ahmed-ali-3']);
    await expect(uniqueSlug('dr-ahmed-ali', (c) => taken.has(c))).resolves.toBe(
      'dr-ahmed-ali-4',
    );
  });
});

describe('StaffService.create — public_slug (uniqueness holds under concurrent insert)', () => {
  let service: StaffService;
  let staff: MockRepository;
  let users: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    staff = createMockRepository();
    users = createMockRepository();
    const manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        {
          provide: getRepositoryToken(StaffServiceEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(BranchUser),
          useValue: createMockRepository(),
        },
        { provide: getRepositoryToken(User), useValue: users },
        {
          provide: getRepositoryToken(UserRole),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(AuditLog),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(Service),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(Branch),
          useValue: createMockRepository(),
        },
        { provide: DataSource, useValue: dataSource },
        { provide: AuthService, useValue: { createUserWithRole: jest.fn() } },
        { provide: RolesService, useValue: {} },
        {
          provide: StaffAccessService,
          useValue: { getAccessStates: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: StorageService,
          useValue: {
            assertKeyBelongsToTenant: jest.fn(),
            getSignedDownloadUrl: jest.fn(),
            deleteObject: jest.fn(),
          },
        },
        {
          provide: UsageService,
          useValue: {
            assertCountWithinLimit: jest.fn(),
            assertUserSeatWithinLimit: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: { sendStaffCredentials: jest.fn() },
        },
        {
          provide: BranchScopeService,
          useValue: {
            resolve: jest.fn().mockResolvedValue({ branchIds: null }),
            resolveCurrent: jest.fn().mockResolvedValue({ branchIds: null }),
            isAllowed: () => true,
            assertBranchAllowed: () => undefined,
            branchFilter: () => undefined,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(StaffService);
  });

  it('assigns a name-derived slug, avoiding candidates the live query reports as taken', async () => {
    users.findOne.mockResolvedValueOnce({
      id: 'u1',
      full_name: 'Dr. Ahmed Ali',
    });
    staff.findOne.mockResolvedValueOnce(null); // no existing profile
    dataSource.query.mockResolvedValueOnce([
      { public_slug: 'dr-ahmed-ali' },
      { public_slug: 'dr-ahmed-ali-2' },
    ]);
    staff.save.mockResolvedValueOnce({ id: 'staff-1' });
    staff.findOne.mockResolvedValueOnce({ id: 'staff-1' });

    await service.create(TENANT, { userId: 'u1' } as any);

    expect(staff.create).toHaveBeenCalledWith(
      expect.objectContaining({ public_slug: 'dr-ahmed-ali-3' }),
    );
  });

  it('retries with a freshly regenerated slug when the INSERT itself races on public_slug (the real concurrent-insert backstop)', async () => {
    users.findOne.mockResolvedValueOnce({
      id: 'u1',
      full_name: 'Dr. Ahmed Ali',
    });
    staff.findOne.mockResolvedValueOnce(null);
    dataSource.query.mockResolvedValueOnce([]); // pre-check: nothing taken (racing request not visible yet)

    const conflict = Object.assign(
      new QueryFailedError('INSERT', [], new Error('duplicate key')),
      { code: '23505', constraint: 'UQ_staff_profiles_public_slug' },
    );
    staff.save.mockRejectedValueOnce(conflict); // first attempt loses the race
    dataSource.query.mockResolvedValueOnce([{ public_slug: 'dr-ahmed-ali' }]); // regenerated pre-check sees the winner now
    staff.save.mockResolvedValueOnce({ id: 'staff-1' }); // second attempt succeeds
    staff.findOne.mockResolvedValueOnce({ id: 'staff-1' });

    await service.create(TENANT, { userId: 'u1' } as any);

    expect(staff.save).toHaveBeenCalledTimes(2);
    expect(staff.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ public_slug: 'dr-ahmed-ali-2' }),
    );
  });

  it('does NOT retry a user_id conflict as if it were a slug conflict — surfaces the clear existing-profile error immediately', async () => {
    users.findOne.mockResolvedValueOnce({
      id: 'u1',
      full_name: 'Dr. Ahmed Ali',
    });
    staff.findOne.mockResolvedValueOnce(null);
    dataSource.query.mockResolvedValueOnce([]);

    const conflict = Object.assign(
      new QueryFailedError('INSERT', [], new Error('duplicate key')),
      { code: '23505', constraint: 'REL_223deb3f390b28562fad70eefe' }, // user_id
    );
    staff.save.mockRejectedValueOnce(conflict);

    await expect(
      service.create(TENANT, { userId: 'u1' } as any),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This user already has a staff profile',
    });
    expect(staff.save).toHaveBeenCalledTimes(1); // no retry — a different candidate would not fix this
  });
});

describe('StaffPublicSlug migration (backfill covers every existing row)', () => {
  function makeQueryMock(responses: Array<[RegExp, unknown]>) {
    return jest.fn(async (sql: string, _params: unknown[]) => {
      for (const [pattern, result] of responses) {
        if (pattern.test(sql)) return result;
      }
      return [];
    });
  }

  it('LEFT JOINs users so a staff_profiles row with no matching user still gets backfilled (not silently skipped)', async () => {
    const query = makeQueryMock([
      [/ADD COLUMN/, []],
      [
        /SELECT sp\.id, u\.full_name/,
        [
          { id: 'orphan-1', full_name: null }, // no matching user — LEFT JOIN, not JOIN
          { id: 'staff-2', full_name: 'Dr. Sara Ahmed' },
        ],
      ],
      [
        /SELECT "public_slug" FROM "staff_profiles" WHERE "public_slug" IS NOT NULL/,
        [],
      ],
      [/SELECT COUNT\(\*\)::int AS c/, [{ c: 0 }]],
    ]);
    await new StaffPublicSlug1730096000000().up({ query } as any);

    const statements = query.mock.calls.map(([s]) => s as string);
    expect(statements.some((s) => /LEFT JOIN "users"/.test(s))).toBe(true);

    const updates = query.mock.calls.filter(([s]) =>
      /UPDATE "staff_profiles" SET "public_slug"/.test(s),
    );
    expect(updates).toHaveLength(2);
    // The orphan (null full_name) still gets a slug — falls back to 'doctor', never left NULL.
    expect(
      updates.some(
        ([, params]) => params[0] === 'doctor' && params[1] === 'orphan-1',
      ),
    ).toBe(true);
    expect(
      updates.some(
        ([, params]) =>
          params[0] === 'dr-sara-ahmed' && params[1] === 'staff-2',
      ),
    ).toBe(true);
  });

  it('refuses to tighten the column if any row is still NULL after the backfill loop (never ships a partial state)', async () => {
    const query = makeQueryMock([
      [/ADD COLUMN/, []],
      [/SELECT sp\.id, u\.full_name/, []], // nothing to backfill this run
      [/SELECT COUNT\(\*\)::int AS c/, [{ c: 3 }]], // yet 3 rows are somehow still NULL
    ]);
    await expect(
      new StaffPublicSlug1730096000000().up({ query } as any),
    ).rejects.toThrow(
      /3 staff_profiles row\(s\) still have a NULL public_slug/,
    );

    const statements = query.mock.calls.map(([s]) => s as string);
    expect(
      statements.some((s) => /ALTER COLUMN "public_slug" SET NOT NULL/.test(s)),
    ).toBe(false);
  });

  it('down() drops the column, the NOT NULL, and the unique index', async () => {
    const query = makeQueryMock([]);
    await new StaffPublicSlug1730096000000().down({ query } as any);
    const statements = query.mock.calls.map(([s]) => s as string);
    expect(
      statements.some((s) =>
        /DROP INDEX IF EXISTS "public"\."UQ_staff_profiles_public_slug"/.test(
          s,
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((s) => /DROP COLUMN IF EXISTS "public_slug"/.test(s)),
    ).toBe(true);
  });
});

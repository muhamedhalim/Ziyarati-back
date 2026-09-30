import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PlatformStaffService } from './platform-staff.service';
import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { EmailDeliveryService } from '../email/email-delivery.service';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import { AppError, ErrorCode } from '../../common/errors';
import { ROLE } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  createMockDataSource,
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
} from '../../../test/utils/mock-factories';

const ACTOR_ID = 'super-admin-1';
const TARGET_ID = 'staff-1';

const platformSupportRole = {
  id: 'role-ps',
  slug: ROLE.PLATFORM_SUPPORT,
  name: 'Platform Customer Service',
} as Role;

describe('PlatformStaffService', () => {
  let service: PlatformStaffService;
  let users: MockRepository;
  let roles: MockRepository;
  let userRoles: MockRepository;
  let passwordResets: MockRepository;
  let dataSource: MockDataSource;
  let authService: {
    createUserWithRole: jest.Mock;
    issuePasswordSetupToken: jest.Mock;
    passwordSetupUrl: jest.Mock;
    revokeAllForUser: jest.Mock;
  };
  let email: { sendInvitation: jest.Mock };
  let emailDelivery: { getLatestStatusByRecipient: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    users = createMockRepository();
    roles = createMockRepository();
    userRoles = createMockRepository();
    passwordResets = createMockRepository();
    dataSource = createMockDataSource();
    authService = {
      createUserWithRole: jest.fn().mockResolvedValue({ id: TARGET_ID }),
      issuePasswordSetupToken: jest.fn().mockResolvedValue('raw-token'),
      passwordSetupUrl: jest.fn(
        (t: string) => `https://app.example/auth/reset-password?token=${t}`,
      ),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    email = { sendInvitation: jest.fn().mockResolvedValue(undefined) };
    emailDelivery = {
      getLatestStatusByRecipient: jest.fn().mockResolvedValue(new Map()),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformStaffService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Role), useValue: roles },
        { provide: getRepositoryToken(UserRole), useValue: userRoles },
        {
          provide: getRepositoryToken(PasswordReset),
          useValue: passwordResets,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: AuthService, useValue: authService },
        { provide: EmailService, useValue: email },
        { provide: EmailDeliveryService, useValue: emailDelivery },
        { provide: PlatformAdminAuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(PlatformStaffService);
  });

  afterEach(() => jest.clearAllMocks());

  // ──────────────────────────────── create ───────────────────────────────── //
  describe('create', () => {
    const dto = {
      email: 'Agent@ZiyaraTech.com',
      fullName: 'Support Agent',
      roleSlug: ROLE.PLATFORM_SUPPORT,
    } as any;

    it('creates the user via AuthService.createUserWithRole with tenantId=null and the resolved role', async () => {
      roles.findOne.mockResolvedValueOnce(platformSupportRole); // role resolution
      users.findOne.mockResolvedValueOnce({
        id: TARGET_ID,
        email: 'agent@ziyaratech.com',
        is_active: true,
      }); // summaryFor
      userRoles.find.mockResolvedValueOnce([]); // decorate() roles
      passwordResets.find.mockResolvedValueOnce([]); // decorate() invites

      await service.create(dto, ACTOR_ID);

      expect(authService.createUserWithRole).toHaveBeenCalledWith(
        dataSource.manager,
        expect.objectContaining({
          email: 'agent@ziyaratech.com',
          fullName: 'Support Agent',
        }),
        platformSupportRole,
        null, // tenantId=null — platform user, never a tenant member
      );
    });

    it('rejects an unseeded role slug before opening a transaction', async () => {
      roles.findOne.mockResolvedValueOnce(null);

      await expect(service.create(dto, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.ROLE_NOT_FOUND,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    // D7 — the global email chokepoint lives in AuthService.createUserWithRole;
    // this proves the platform-staff route surfaces that rejection cleanly.
    it('propagates EMAIL_ALREADY_EXISTS from the createUserWithRole chokepoint (duplicate email, any scope)', async () => {
      roles.findOne.mockResolvedValueOnce(platformSupportRole);
      authService.createUserWithRole.mockRejectedValueOnce(
        new AppError(ErrorCode.EMAIL_ALREADY_EXISTS),
      );

      await expect(service.create(dto, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.EMAIL_ALREADY_EXISTS,
      });
      expect(email.sendInvitation).not.toHaveBeenCalled();
    });

    it('sends the invitation with a passwordSetupUrl and never returns/logs a password', async () => {
      roles.findOne.mockResolvedValueOnce(platformSupportRole);
      users.findOne.mockResolvedValueOnce({
        id: TARGET_ID,
        email: 'agent@ziyaratech.com',
        is_active: true,
      });
      userRoles.find.mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);

      const result = await service.create(dto, ACTOR_ID);

      expect(authService.issuePasswordSetupToken).toHaveBeenCalledWith(
        TARGET_ID,
      );
      expect(email.sendInvitation).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'agent@ziyaratech.com',
          invitationUrl:
            'https://app.example/auth/reset-password?token=raw-token',
        }),
      );
      expect(JSON.stringify(result)).not.toMatch(/password/i);
    });

    it('a mail delivery failure does NOT roll back the already-created user', async () => {
      roles.findOne.mockResolvedValueOnce(platformSupportRole);
      users.findOne.mockResolvedValueOnce({
        id: TARGET_ID,
        email: 'agent@ziyaratech.com',
        is_active: true,
      });
      userRoles.find.mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);
      email.sendInvitation.mockRejectedValueOnce(new Error('SMTP down'));

      await expect(service.create(dto, ACTOR_ID)).resolves.toMatchObject({
        id: TARGET_ID,
      });
    });

    it('records a STAFF_CREATE audit entry', async () => {
      roles.findOne.mockResolvedValueOnce(platformSupportRole);
      users.findOne.mockResolvedValueOnce({
        id: TARGET_ID,
        email: 'agent@ziyaratech.com',
        is_active: true,
      });
      userRoles.find.mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);

      await service.create(dto, ACTOR_ID);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_CREATE,
          userId: ACTOR_ID,
          entityType: 'PlatformStaff',
          entityId: TARGET_ID,
        }),
      );
    });
  });

  // ──────────────────────────── target protection ────────────────────────── //
  describe('target lookup / protection invariants', () => {
    it('a tenant-scoped user id (or any nonexistent id) is 404 — never leaks that a tenant user exists', async () => {
      users.findOne.mockResolvedValueOnce(null); // tenant IS NULL filter excludes it

      await expect(
        service.update(TARGET_ID, { fullName: 'X' } as any, ACTOR_ID),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('refuses to mutate a target holding super_admin (FORBIDDEN, not 404)', async () => {
      users.findOne.mockResolvedValueOnce({ id: TARGET_ID, tenant: null });
      userRoles.find.mockResolvedValueOnce([
        { role: { slug: ROLE.SUPER_ADMIN } },
      ]);

      await expect(
        service.update(TARGET_ID, { fullName: 'X' } as any, ACTOR_ID),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });
  });

  // ──────────────────────────────── setStatus ─────────────────────────────── //
  describe('setStatus', () => {
    it('refuses self-deactivation without touching the database', async () => {
      await expect(
        service.setStatus(ACTOR_ID, { isActive: false } as any, ACTOR_ID),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('deactivating revokes every refresh token for the target', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true }) // loadTarget
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: false }); // summaryFor
      userRoles.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);

      await service.setStatus(TARGET_ID, { isActive: false } as any, ACTOR_ID);

      expect(users.update).toHaveBeenCalledWith(
        { id: TARGET_ID },
        { is_active: false },
      );
      expect(authService.revokeAllForUser).toHaveBeenCalledWith(TARGET_ID);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_DEACTIVATE,
        }),
      );
    });

    it('activating does NOT call revokeAllForUser', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: false })
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true });
      userRoles.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);

      await service.setStatus(TARGET_ID, { isActive: true } as any, ACTOR_ID);

      expect(authService.revokeAllForUser).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_ACTIVATE,
        }),
      );
    });

    it('is idempotent: no-op when the status already matches, no audit write', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true }) // loadTarget
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true }); // summaryFor
      userRoles.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);

      await service.setStatus(TARGET_ID, { isActive: true } as any, ACTOR_ID);

      expect(users.update).not.toHaveBeenCalled();
      expect(authService.revokeAllForUser).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────── setRoles ──────────────────────────────── //
  describe('setRoles', () => {
    it('refuses self-role-change without touching the database', async () => {
      await expect(
        service.setRoles(
          ACTOR_ID,
          { roleSlugs: [ROLE.PLATFORM_SUPPORT] } as any,
          ACTOR_ID,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('rejects super_admin even if it somehow bypasses DTO validation — no row is written', async () => {
      users.findOne.mockResolvedValueOnce({ id: TARGET_ID });
      userRoles.find.mockResolvedValueOnce([]); // current roles (loadTarget)

      await expect(
        service.setRoles(
          TARGET_ID,
          { roleSlugs: [ROLE.SUPER_ADMIN] } as any,
          ACTOR_ID,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('replaces user_roles inside a transaction and revokes sessions (permission set changed)', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: TARGET_ID })
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true });
      userRoles.find
        .mockResolvedValueOnce([]) // loadTarget: current roles
        .mockResolvedValueOnce([{ role: { slug: ROLE.PLATFORM_SUPPORT } }]); // decorate() after
      passwordResets.find.mockResolvedValueOnce([]);
      roles.find.mockResolvedValueOnce([platformSupportRole]);

      await service.setRoles(
        TARGET_ID,
        { roleSlugs: [ROLE.PLATFORM_SUPPORT] } as any,
        ACTOR_ID,
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(authService.revokeAllForUser).toHaveBeenCalledWith(TARGET_ID);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_ROLES_SET,
        }),
      );
    });
  });

  // ──────────────────────────────── list ──────────────────────────────────── //
  describe('list', () => {
    it('excludes super_admin at the query level and paginates', async () => {
      const qb = createMockQueryBuilder();
      qb.getManyAndCount = jest
        .fn()
        .mockResolvedValueOnce([[{ id: TARGET_ID }], 1]);
      users.createQueryBuilder = jest.fn(() => qb);
      userRoles.find.mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);

      const result = await service.list({ page: 1, limit: 20 } as any);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('NOT EXISTS'),
        expect.objectContaining({ superAdmin: ROLE.SUPER_ADMIN }),
      );
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('orders by created_at DESC with an id tiebreaker so paging is stable when timestamps tie', async () => {
      const qb = createMockQueryBuilder();
      qb.getManyAndCount = jest.fn().mockResolvedValueOnce([[], 0]);
      users.createQueryBuilder = jest.fn(() => qb);

      await service.list({ page: 1, limit: 20 } as any);

      expect(qb.orderBy).toHaveBeenCalledWith('u.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('u.id', 'DESC');
    });
  });

  // ──────────────────────── invitation delivery status ───────────────────── //
  describe('invitation delivery status', () => {
    const baseUser = {
      id: TARGET_ID,
      email: 'agent@ziyaratech.com',
      is_active: true,
      last_login_at: null,
      created_at: new Date(),
    };

    function mockListOf(user: any) {
      const qb = createMockQueryBuilder();
      qb.getManyAndCount = jest.fn().mockResolvedValueOnce([[user], 1]);
      users.createQueryBuilder = jest.fn(() => qb);
    }

    it('queries the batched delivery status for exactly the listed addresses and the invite template', async () => {
      mockListOf(baseUser);
      userRoles.find.mockResolvedValueOnce([
        { user: { id: TARGET_ID }, role: { slug: ROLE.PLATFORM_SUPPORT } },
      ]);
      passwordResets.find.mockResolvedValueOnce([]);

      await service.list({ page: 1, limit: 20 } as any);

      expect(emailDelivery.getLatestStatusByRecipient).toHaveBeenCalledWith(
        ['agent@ziyaratech.com'],
        'staff_invitation',
      );
    });

    it('surfaces invitation_failed when the latest recorded delivery attempt for the address is FAILED — even with a live, unexpired invite token', async () => {
      mockListOf(baseUser);
      userRoles.find.mockResolvedValueOnce([
        { user: { id: TARGET_ID }, role: { slug: ROLE.PLATFORM_SUPPORT } },
      ]);
      passwordResets.find.mockResolvedValueOnce([
        {
          user: { id: TARGET_ID },
          used_at: null,
          expires_at: new Date(Date.now() + 60_000), // still live
        },
      ]);
      emailDelivery.getLatestStatusByRecipient.mockResolvedValueOnce(
        new Map([['agent@ziyaratech.com', 'FAILED']]),
      );

      const result = await service.list({ page: 1, limit: 20 } as any);

      expect(result.data[0].invitationStatus).toBe('invitation_failed');
    });

    it('stays invitation_pending when no delivery attempt has been recorded yet (e.g. nothing has consumed the queue)', async () => {
      mockListOf(baseUser);
      userRoles.find.mockResolvedValueOnce([
        { user: { id: TARGET_ID }, role: { slug: ROLE.PLATFORM_SUPPORT } },
      ]);
      passwordResets.find.mockResolvedValueOnce([
        {
          user: { id: TARGET_ID },
          used_at: null,
          expires_at: new Date(Date.now() + 60_000),
        },
      ]);
      emailDelivery.getLatestStatusByRecipient.mockResolvedValueOnce(
        new Map(),
      );

      const result = await service.list({ page: 1, limit: 20 } as any);

      expect(result.data[0].invitationStatus).toBe('invitation_pending');
    });

    it('a SENT delivery does not mark the invitation as failed', async () => {
      mockListOf(baseUser);
      userRoles.find.mockResolvedValueOnce([
        { user: { id: TARGET_ID }, role: { slug: ROLE.PLATFORM_SUPPORT } },
      ]);
      passwordResets.find.mockResolvedValueOnce([
        {
          user: { id: TARGET_ID },
          used_at: null,
          expires_at: new Date(Date.now() + 60_000),
        },
      ]);
      emailDelivery.getLatestStatusByRecipient.mockResolvedValueOnce(
        new Map([['agent@ziyaratech.com', 'SENT']]),
      );

      const result = await service.list({ page: 1, limit: 20 } as any);

      expect(result.data[0].invitationStatus).toBe('invitation_pending');
    });

    it('is not_invited when no token was ever issued (created with sendInvitation: false)', async () => {
      mockListOf(baseUser);
      userRoles.find.mockResolvedValueOnce([
        { user: { id: TARGET_ID }, role: { slug: ROLE.PLATFORM_SALES } },
      ]);
      passwordResets.find.mockResolvedValueOnce([]); // never invited

      const result = await service.list({ page: 1, limit: 20 } as any);

      expect(result.data[0].invitationStatus).toBe('not_invited');
    });

    it('an expired (but once-issued) token is invitation_expired, never not_invited', async () => {
      mockListOf(baseUser);
      userRoles.find.mockResolvedValueOnce([
        { user: { id: TARGET_ID }, role: { slug: ROLE.PLATFORM_SALES } },
      ]);
      passwordResets.find.mockResolvedValueOnce([
        { user: { id: TARGET_ID }, used_at: null, expires_at: new Date(Date.now() - 60_000) },
      ]);

      const result = await service.list({ page: 1, limit: 20 } as any);

      expect(result.data[0].invitationStatus).toBe('invitation_expired');
    });
  });

  // ─────────────────── sales role: provisioning without login ───────────────── //
  describe('sales employees (platform_sales)', () => {
    const salesRole = {
      id: 'role-sales',
      slug: ROLE.PLATFORM_SALES,
      name: 'Platform Sales',
    } as Role;
    const salesDto = {
      email: 'Rep@ZiyaraTech.com',
      fullName: 'Sales Rep',
      roleSlug: ROLE.PLATFORM_SALES,
    } as any;

    function primeCreate() {
      roles.findOne.mockResolvedValueOnce(salesRole);
      users.findOne.mockResolvedValueOnce({ id: TARGET_ID, email: 'rep@ziyaratech.com', is_active: true });
      userRoles.find.mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);
    }

    it('creates a platform_sales user, invited by default', async () => {
      primeCreate();
      await service.create(salesDto, ACTOR_ID);
      expect(authService.createUserWithRole).toHaveBeenCalledWith(
        dataSource.manager,
        expect.anything(),
        salesRole,
        null,
      );
      expect(authService.issuePasswordSetupToken).toHaveBeenCalledWith(TARGET_ID);
      expect(email.sendInvitation).toHaveBeenCalledTimes(1);
    });

    it('sendInvitation:false provisions the account with NO token and NO email, and audits invited:false', async () => {
      primeCreate();
      await service.create({ ...salesDto, sendInvitation: false }, ACTOR_ID);
      expect(authService.createUserWithRole).toHaveBeenCalledTimes(1);
      expect(authService.issuePasswordSetupToken).not.toHaveBeenCalled();
      expect(email.sendInvitation).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_CREATE,
          after: expect.objectContaining({ invited: false }),
        }),
      );
    });

    it('setStatus reports how many clinics the account still owns (so the UI can prompt a hand-off)', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true }) // loadTarget
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: false }); // summaryFor
      userRoles.find.mockResolvedValue([]);
      passwordResets.find.mockResolvedValue([]);
      dataSource.query.mockResolvedValueOnce([{ c: 12 }]);

      const res = await service.setStatus(TARGET_ID, { isActive: false } as any, ACTOR_ID);

      expect(res.activeAssignments).toBe(12);
      const [sql, params] = dataSource.query.mock.calls[0];
      expect(sql).toContain('ended_at IS NULL');
      expect(params).toEqual([TARGET_ID]);
    });

    it('removing the sales role is REFUSED while the employee still owns clinics', async () => {
      users.findOne.mockResolvedValueOnce({ id: TARGET_ID });
      userRoles.find.mockResolvedValueOnce([{ slug: ROLE.PLATFORM_SALES }].map((r) => ({ role: r })));
      roles.find.mockResolvedValueOnce([platformSupportRole]);
      dataSource.query.mockResolvedValueOnce([{ c: 3 }]);

      await expect(
        service.setRoles(TARGET_ID, { roleSlugs: [ROLE.PLATFORM_SUPPORT] } as any, ACTOR_ID),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: { activeAssignments: 3 },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(authService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('removing the sales role is allowed once the portfolio is empty', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: TARGET_ID })
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true });
      userRoles.find
        .mockResolvedValueOnce([{ role: { slug: ROLE.PLATFORM_SALES } }])
        .mockResolvedValueOnce([{ role: { slug: ROLE.PLATFORM_SUPPORT } }]);
      passwordResets.find.mockResolvedValueOnce([]);
      roles.find.mockResolvedValueOnce([platformSupportRole]);
      dataSource.query.mockResolvedValueOnce([{ c: 0 }]);

      await service.setRoles(TARGET_ID, { roleSlugs: [ROLE.PLATFORM_SUPPORT] } as any, ACTOR_ID);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('keeping the sales role does not even count assignments', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: TARGET_ID })
        .mockResolvedValueOnce({ id: TARGET_ID, is_active: true });
      userRoles.find
        .mockResolvedValueOnce([{ role: { slug: ROLE.PLATFORM_SALES } }])
        .mockResolvedValueOnce([{ role: { slug: ROLE.PLATFORM_SALES } }]);
      passwordResets.find.mockResolvedValueOnce([]);
      roles.find.mockResolvedValueOnce([salesRole]);

      await service.setRoles(TARGET_ID, { roleSlugs: [ROLE.PLATFORM_SALES] } as any, ACTOR_ID);

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('list can be filtered to one platform role', async () => {
      const qb = createMockQueryBuilder();
      qb.getManyAndCount = jest.fn().mockResolvedValueOnce([[], 0]);
      users.createQueryBuilder = jest.fn(() => qb);

      await service.list({ page: 1, limit: 20, role: ROLE.PLATFORM_SALES } as any);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('r2.slug = :roleFilter'),
        { roleFilter: ROLE.PLATFORM_SALES },
      );
    });

    it('summarize returns platform-scope users in the REQUESTED order and drops unknown ids', async () => {
      users.find.mockResolvedValueOnce([
        { id: 'a', email: 'a@x.io', is_active: true, created_at: new Date() },
        { id: 'b', email: 'b@x.io', is_active: true, created_at: new Date() },
      ]);
      userRoles.find.mockResolvedValueOnce([]);
      passwordResets.find.mockResolvedValueOnce([]);

      const res = await service.summarize(['b', 'ghost', 'a']);

      expect(res.map((s) => s.id)).toEqual(['b', 'a']);
      // one users query + the 3 batched decorate queries, regardless of size
      expect(users.find).toHaveBeenCalledTimes(1);
    });

    it('summarize([]) touches nothing', async () => {
      await expect(service.summarize([])).resolves.toEqual([]);
      expect(users.find).not.toHaveBeenCalled();
    });
  });
});

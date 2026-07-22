import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffAccessService } from './staff-access.service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { AuthService } from '../auth/auth.service';
import { RolesService } from '../auth/roles.service';
import { EmailService } from '../email/email.service';
import { ErrorCode } from '../../common/errors';
import { ROLE } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const OTHER_TENANT = 't2';
const STAFF_ID = 'staff-1';
const USER_ID = 'u1';
const ACTOR = 'owner-1';

const receptionRole = {
  id: 'role-receptionist',
  slug: ROLE.RECEPTIONIST,
  name: 'Receptionist',
};

describe('StaffAccessService', () => {
  let service: StaffAccessService;
  let staff: MockRepository;
  let users: MockRepository;
  let userRoles: MockRepository;
  let passwordResets: MockRepository;
  let auditLogs: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let authService: {
    revokeAllForUser: jest.Mock;
    issuePasswordSetupToken: jest.Mock;
    passwordSetupUrl: jest.Mock;
  };
  let rolesService: {
    listUserRoles: jest.Mock;
    findAssignableRoleBySlug: jest.Mock;
  };
  let email: { sendInvitation: jest.Mock };

  /** Wires the happy-path lookups: staff row → account → current roles. */
  const arrangeTarget = (opts?: {
    roles?: { id: string; slug: string }[];
    user?: Partial<User>;
    staffFound?: boolean;
    userFound?: boolean;
  }) => {
    const {
      roles = [{ id: 'role-x', slug: 'custom-role' }],
      user = {},
      staffFound = true,
      userFound = true,
    } = opts ?? {};

    staff.findOne.mockResolvedValueOnce(
      staffFound ? { id: STAFF_ID, user: { id: USER_ID } } : null,
    );
    users.findOne.mockResolvedValueOnce(
      userFound
        ? {
            id: USER_ID,
            email: 'rec@clinic.com',
            full_name: 'Rec',
            is_active: true,
            last_login_at: null,
            ...user,
          }
        : null,
    );
    rolesService.listUserRoles.mockResolvedValueOnce(roles);
  };

  /** Stubs the post-mutation `stateFor` re-read. */
  const arrangeStateRead = (opts?: {
    roles?: string[];
    isActive?: boolean;
    lastLoginAt?: Date | null;
  }) => {
    const {
      roles = [ROLE.RECEPTIONIST],
      isActive = true,
      lastLoginAt = null,
    } = opts ?? {};
    users.find.mockResolvedValueOnce([
      { id: USER_ID, is_active: isActive, last_login_at: lastLoginAt },
    ]);
    userRoles.find.mockResolvedValueOnce(
      roles.map((slug) => ({ user: { id: USER_ID }, role: { slug } })),
    );
    passwordResets.find.mockResolvedValueOnce([]);
  };

  beforeEach(async () => {
    staff = createMockRepository();
    users = createMockRepository();
    userRoles = createMockRepository();
    passwordResets = createMockRepository();
    auditLogs = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);

    authService = {
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
      issuePasswordSetupToken: jest.fn().mockResolvedValue('raw-token'),
      passwordSetupUrl: jest.fn().mockReturnValue('https://app/reset?token=x'),
    };
    rolesService = {
      listUserRoles: jest.fn(),
      findAssignableRoleBySlug: jest.fn().mockResolvedValue(receptionRole),
    };
    email = { sendInvitation: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffAccessService,
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(UserRole), useValue: userRoles },
        { provide: getRepositoryToken(PasswordReset), useValue: passwordResets },
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
        { provide: DataSource, useValue: dataSource },
        { provide: AuthService, useValue: authService },
        { provide: RolesService, useValue: rolesService },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    service = moduleRef.get(StaffAccessService);
  });

  afterEach(() => jest.clearAllMocks());

  const repo = (entity: unknown) =>
    manager.getRepository(entity) as unknown as MockRepository;

  // ─────────────────────────────── grant ──────────────────────────────────── //

  describe('grant', () => {
    it('replaces the existing role with receptionist and re-enables the account', async () => {
      arrangeTarget({ roles: [{ id: 'role-x', slug: 'custom-role' }] });
      arrangeStateRead();

      await service.grant(TENANT, STAFF_ID, ACTOR);

      // Old roles cleared, receptionist inserted — a REPLACE, not an add.
      expect(repo(UserRole).delete).toHaveBeenCalledWith({
        user: { id: USER_ID },
      });
      expect(repo(UserRole).create).toHaveBeenCalledWith({
        user: { id: USER_ID },
        role: { id: receptionRole.id },
      });
      expect(repo(User).update).toHaveBeenCalledWith(
        { id: USER_ID },
        { is_active: true },
      );
    });

    it('resolves the role server-side from the RBAC catalogue, never from input', async () => {
      arrangeTarget();
      arrangeStateRead();

      await service.grant(TENANT, STAFF_ID, ACTOR);

      expect(rolesService.findAssignableRoleBySlug).toHaveBeenCalledWith(
        ROLE.RECEPTIONIST,
        TENANT,
      );
    });

    it('revokes existing sessions because the permission set changed', async () => {
      arrangeTarget();
      arrangeStateRead();

      await service.grant(TENANT, STAFF_ID, ACTOR);

      expect(authService.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
    });

    it('emails a set-password invitation when the person has never signed in', async () => {
      arrangeTarget({ user: { last_login_at: null } });
      arrangeStateRead();

      await service.grant(TENANT, STAFF_ID, ACTOR);

      expect(authService.issuePasswordSetupToken).toHaveBeenCalledWith(USER_ID);
      expect(email.sendInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'rec@clinic.com', role: 'Receptionist' }),
      );
    });

    it('does not re-send an invitation to someone who has already signed in', async () => {
      arrangeTarget({ user: { last_login_at: new Date() } });
      arrangeStateRead({ lastLoginAt: new Date() });

      await service.grant(TENANT, STAFF_ID, ACTOR);

      expect(email.sendInvitation).not.toHaveBeenCalled();
    });

    it('is idempotent for an already-active receptionist (no session wipe, no email)', async () => {
      arrangeTarget({ roles: [receptionRole], user: { is_active: true } });
      arrangeStateRead();

      await service.grant(TENANT, STAFF_ID, ACTOR);

      expect(repo(UserRole).delete).not.toHaveBeenCalled();
      expect(authService.revokeAllForUser).not.toHaveBeenCalled();
      expect(email.sendInvitation).not.toHaveBeenCalled();
    });

    it('refuses to touch an owner account', async () => {
      arrangeTarget({ roles: [{ id: 'r-owner', slug: ROLE.OWNER }] });

      await expect(
        service.grant(TENANT, STAFF_ID, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(repo(UserRole).delete).not.toHaveBeenCalled();
    });

    it('refuses to touch a super admin account', async () => {
      arrangeTarget({ roles: [{ id: 'r-sa', slug: ROLE.SUPER_ADMIN }] });

      await expect(
        service.grant(TENANT, STAFF_ID, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('rejects a staff id from another clinic as not-found (IDOR)', async () => {
      staff.findOne.mockResolvedValueOnce(null);

      await expect(
        service.grant(OTHER_TENANT, STAFF_ID, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      // The tenant filter is applied in the query itself.
      expect(staff.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: STAFF_ID, tenant: { id: OTHER_TENANT } },
        }),
      );
    });

    it('rejects when the linked account is not in the caller clinic', async () => {
      arrangeTarget({ userFound: false });

      await expect(
        service.grant(TENANT, STAFF_ID, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('rejects a staff member with no email address', async () => {
      arrangeTarget({ user: { email: undefined } });

      await expect(
        service.grant(TENANT, STAFF_ID, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('records an audit entry without any token or credential', async () => {
      arrangeTarget();
      arrangeStateRead();

      await service.grant(TENANT, STAFF_ID, ACTOR);

      expect(auditLogs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'staff.dashboard_access.granted',
          entity_type: 'staff_profile',
          entity_id: STAFF_ID,
        }),
      );
      const logged = JSON.stringify(auditLogs.create.mock.calls[0][0]);
      expect(logged).not.toContain('raw-token');
    });
  });

  // ───────────────────────────── enable/disable ───────────────────────────── //

  describe('setEnabled', () => {
    it('disables login and kills live sessions without deleting the staff record', async () => {
      arrangeTarget({ roles: [receptionRole], user: { is_active: true } });
      arrangeStateRead({ isActive: false });

      await service.setEnabled(TENANT, STAFF_ID, false, ACTOR);

      expect(users.update).toHaveBeenCalledWith(
        { id: USER_ID },
        { is_active: false },
      );
      expect(authService.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
      // The staff profile itself is never removed or soft-deleted here.
      expect(staff.softRemove).not.toHaveBeenCalled();
      expect(staff.remove).not.toHaveBeenCalled();
      expect(staff.save).not.toHaveBeenCalled();
    });

    it('re-enables login without revoking sessions', async () => {
      arrangeTarget({ roles: [receptionRole], user: { is_active: false } });
      arrangeStateRead({ isActive: true });

      await service.setEnabled(TENANT, STAFF_ID, true, ACTOR);

      expect(users.update).toHaveBeenCalledWith(
        { id: USER_ID },
        { is_active: true },
      );
      expect(authService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('is a no-op when already in the requested state', async () => {
      arrangeTarget({ roles: [receptionRole], user: { is_active: true } });
      arrangeStateRead();

      await service.setEnabled(TENANT, STAFF_ID, true, ACTOR);

      expect(users.update).not.toHaveBeenCalled();
    });

    it('rejects a staff member who was never granted access', async () => {
      arrangeTarget({ roles: [{ id: 'r', slug: 'custom-role' }] });

      await expect(
        service.setEnabled(TENANT, STAFF_ID, false, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('refuses to disable an owner account', async () => {
      arrangeTarget({ roles: [{ id: 'r-owner', slug: ROLE.OWNER }] });

      await expect(
        service.setEnabled(TENANT, STAFF_ID, false, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });
  });

  // ──────────────────────────── resend invitation ─────────────────────────── //

  describe('resendInvitation', () => {
    it('issues a fresh token and re-sends the email', async () => {
      arrangeTarget({ roles: [receptionRole], user: { last_login_at: null } });
      arrangeStateRead();

      await service.resendInvitation(TENANT, STAFF_ID, ACTOR);

      expect(authService.issuePasswordSetupToken).toHaveBeenCalledWith(USER_ID);
      expect(email.sendInvitation).toHaveBeenCalled();
    });

    it('refuses once the person has already signed in', async () => {
      arrangeTarget({
        roles: [receptionRole],
        user: { last_login_at: new Date() },
      });

      await expect(
        service.resendInvitation(TENANT, STAFF_ID, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(email.sendInvitation).not.toHaveBeenCalled();
    });

    it('refuses for a staff member without access', async () => {
      arrangeTarget({ roles: [{ id: 'r', slug: 'custom-role' }] });

      await expect(
        service.resendInvitation(TENANT, STAFF_ID, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });
  });

  // ────────────────────────────── status derivation ───────────────────────── //

  describe('getAccessStates', () => {
    const arrangeStates = (
      user: Partial<User>,
      roles: string[],
      resets: { used_at?: Date; expires_at: Date }[] = [],
    ) => {
      users.find.mockResolvedValueOnce([
        { id: USER_ID, is_active: true, last_login_at: null, ...user },
      ]);
      userRoles.find.mockResolvedValueOnce(
        roles.map((slug) => ({ user: { id: USER_ID }, role: { slug } })),
      );
      passwordResets.find.mockResolvedValueOnce(
        resets.map((r) => ({ ...r, user: { id: USER_ID } })),
      );
    };

    const future = () => new Date(Date.now() + 60_000);
    const past = () => new Date(Date.now() - 60_000);

    it('returns no_access without the receptionist role', async () => {
      arrangeStates({}, ['custom-role']);
      const states = await service.getAccessStates([USER_ID]);
      expect(states.get(USER_ID)?.status).toBe('no_access');
    });

    it('returns disabled for an inactive account', async () => {
      arrangeStates({ is_active: false }, [ROLE.RECEPTIONIST]);
      const states = await service.getAccessStates([USER_ID]);
      expect(states.get(USER_ID)?.status).toBe('disabled');
    });

    it('returns active once the person has signed in', async () => {
      arrangeStates({ last_login_at: new Date() }, [ROLE.RECEPTIONIST]);
      const states = await service.getAccessStates([USER_ID]);
      expect(states.get(USER_ID)?.status).toBe('active');
    });

    it('returns invitation_pending while a live token exists', async () => {
      arrangeStates({}, [ROLE.RECEPTIONIST], [{ expires_at: future() }]);
      const states = await service.getAccessStates([USER_ID]);
      expect(states.get(USER_ID)?.status).toBe('invitation_pending');
    });

    it('returns invitation_expired when every issued token has lapsed', async () => {
      arrangeStates({}, [ROLE.RECEPTIONIST], [{ expires_at: past() }]);
      const states = await service.getAccessStates([USER_ID]);
      expect(states.get(USER_ID)?.status).toBe('invitation_expired');
    });

    it('treats a used token as not live', async () => {
      arrangeStates(
        {},
        [ROLE.RECEPTIONIST],
        [{ expires_at: future(), used_at: new Date() }],
      );
      const states = await service.getAccessStates([USER_ID]);
      expect(states.get(USER_ID)?.status).toBe('invitation_expired');
    });

    it('short-circuits with no queries for an empty id list', async () => {
      await expect(service.getAccessStates([])).resolves.toEqual(new Map());
      expect(users.find).not.toHaveBeenCalled();
    });
  });
});

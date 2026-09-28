import { Test, TestingModule } from '@nestjs/testing';
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
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
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
  let authService: {
    revokeAllForUser: jest.Mock;
    issuePasswordSetupToken: jest.Mock;
    passwordSetupUrl: jest.Mock;
  };
  let rolesService: {
    listUserRoles: jest.Mock;
  };
  let email: { sendInvitation: jest.Mock };

  /** Wires the happy-path lookups: staff row → account → current roles. */
  const arrangeTarget = (opts?: {
    roles?: { id: string; slug: string }[];
    // `last_login_at` is widened to allow `null` on top of `Partial<User>`'s
    // `Date | undefined`: the column is nullable (see the User entity) and a
    // fresh account genuinely reads back `null`, not `undefined` — the
    // entity's `?:` shorthand just doesn't spell out the DB truth precisely.
    user?: Omit<Partial<User>, 'last_login_at'> & { last_login_at?: Date | null };
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

    authService = {
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
      issuePasswordSetupToken: jest.fn().mockResolvedValue('raw-token'),
      passwordSetupUrl: jest.fn().mockReturnValue('https://app/reset?token=x'),
    };
    rolesService = {
      listUserRoles: jest.fn(),
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
        { provide: AuthService, useValue: authService },
        { provide: RolesService, useValue: rolesService },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    service = moduleRef.get(StaffAccessService);
  });

  afterEach(() => jest.clearAllMocks());

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

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffScopeService } from './staff-scope.service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppRedisService } from '../../queue/app-redis.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { ErrorCode } from '../../common/errors';
import { PERMISSION, ROLE, ROLE_PERMISSIONS } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';
const STAFF_ID = 'staff-1';

const perms = (role: string): string[] => ROLE_PERMISSIONS[role] as string[];

describe('StaffScopeService', () => {
  let service: StaffScopeService;
  let staffProfiles: MockRepository;
  let appointments: MockRepository;
  let redis: { application: { get: jest.Mock; set: jest.Mock } };
  let context: { getUser: jest.Mock };

  /** The ambient principal `TenantContextInterceptor` would publish. */
  const actAs = (permissions: string[] | null, id = USER) =>
    context.getUser.mockReturnValue(
      permissions === null ? null : { id, tenantId: TENANT, permissions },
    );

  beforeEach(async () => {
    staffProfiles = createMockRepository();
    appointments = createMockRepository();
    redis = {
      application: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      },
    };
    context = { getUser: jest.fn().mockReturnValue(null) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffScopeService,
        { provide: getRepositoryToken(StaffProfile), useValue: staffProfiles },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: AppRedisService, useValue: redis },
        { provide: TenantContextService, useValue: context },
      ],
    }).compile();
    service = moduleRef.get(StaffScopeService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── The rule ─────────────────────────────────────────────────────────────

  it("resolves the caller's own StaffProfile id, scoped by (userId, tenantId)", async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

    const result = await service.resolveOwnStaffId(TENANT, USER);

    expect(result).toBe(STAFF_ID);
    expect(staffProfiles.findOne).toHaveBeenCalledWith({
      where: { user: { id: USER }, tenant: { id: TENANT } },
      select: { id: true },
    });
  });

  it('returns null (never throws) when the caller owns no StaffProfile — e.g. an Owner/Manager account', async () => {
    staffProfiles.findOne.mockResolvedValueOnce(null);

    await expect(service.resolveOwnStaffId(TENANT, USER)).resolves.toBeNull();
  });

  // ── Caching ──────────────────────────────────────────────────────────────

  it('caches the resolved id under a TENANT-qualified key, so a second call skips the database', async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
    await service.resolveOwnStaffId(TENANT, USER);

    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:${TENANT}:${USER}`,
      STAFF_ID,
      'EX',
      expect.any(Number),
    );

    redis.application.get.mockResolvedValueOnce(STAFF_ID);
    staffProfiles.findOne.mockClear();
    const second = await service.resolveOwnStaffId(TENANT, USER);
    expect(second).toBe(STAFF_ID);
    expect(staffProfiles.findOne).not.toHaveBeenCalled();
  });

  it("caches a 'no profile' answer too — a cache hit of the empty-string sentinel resolves to null without a database read", async () => {
    staffProfiles.findOne.mockResolvedValueOnce(null);
    await service.resolveOwnStaffId(TENANT, USER);

    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:${TENANT}:${USER}`,
      '',
      'EX',
      expect.any(Number),
    );

    redis.application.get.mockResolvedValueOnce('');
    staffProfiles.findOne.mockClear();
    const second = await service.resolveOwnStaffId(TENANT, USER);
    expect(second).toBeNull();
    expect(staffProfiles.findOne).not.toHaveBeenCalled();
  });

  it('falls through to the database when Redis errors on read — a cache hiccup is never a 500', async () => {
    redis.application.get.mockRejectedValueOnce(new Error('down'));
    redis.application.set.mockRejectedValueOnce(new Error('down'));
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

    await expect(service.resolveOwnStaffId(TENANT, USER)).resolves.toBe(STAFF_ID);
  });

  it('still returns the resolved value when Redis errors on write', async () => {
    redis.application.set.mockRejectedValueOnce(new Error('down'));
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

    await expect(service.resolveOwnStaffId(TENANT, USER)).resolves.toBe(STAFF_ID);
  });

  it('a different user gets a distinct cache key — no cross-user bleed', async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
    await service.resolveOwnStaffId(TENANT, USER);

    staffProfiles.findOne.mockResolvedValueOnce({ id: 'staff-2' });
    const other = await service.resolveOwnStaffId(TENANT, 'u2');

    expect(other).toBe('staff-2');
    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:${TENANT}:u2`,
      'staff-2',
      'EX',
      expect.any(Number),
    );
  });

  it('a different tenant gets a distinct cache key — no cross-tenant bleed', async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
    await service.resolveOwnStaffId(TENANT, USER);

    staffProfiles.findOne.mockResolvedValueOnce({ id: 'staff-2' });
    const other = await service.resolveOwnStaffId('t2', USER);

    expect(other).toBe('staff-2');
    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:t2:${USER}`,
      'staff-2',
      'EX',
      expect.any(Number),
    );
  });

  // ── Write-side own-staff gate ────────────────────────────────────────────

  describe('isCurrentPrincipalStatusWriteScoped', () => {
    it('is true for the doctor', () => {
      actAs(perms(ROLE.DOCTOR));
      expect(service.isCurrentPrincipalStatusWriteScoped()).toBe(true);
    });

    it.each([ROLE.NURSE, ROLE.RECEPTIONIST, ROLE.OWNER, ROLE.MANAGER])(
      'is false for %s',
      (role) => {
        actAs(perms(role));
        expect(service.isCurrentPrincipalStatusWriteScoped()).toBe(false);
      },
    );

    it('is false with no principal at all (worker job, payment listener, patient flow)', () => {
      actAs(null);
      expect(service.isCurrentPrincipalStatusWriteScoped()).toBe(false);
    });
  });

  describe('assertMayDriveAppointment', () => {
    it("lets a doctor drive an appointment assigned to THEIR OWN StaffProfile, and reports that it was confined", async () => {
      actAs(perms(ROLE.DOCTOR));
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

      await expect(
        service.assertMayDriveAppointment(TENANT, STAFF_ID),
      ).resolves.toBe(true);
    });

    it("refuses another doctor's appointment with the SAME NOT_FOUND an own-scoped read returns", async () => {
      actAs(perms(ROLE.DOCTOR));
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

      await expect(
        service.assertMayDriveAppointment(TENANT, 'someone-else'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        message: 'Appointment not found',
      });
    });

    it('uses the caller-supplied not-found message, so a queue-entry refusal is byte-identical to a missing entry', async () => {
      actAs(perms(ROLE.DOCTOR));
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

      await expect(
        service.assertMayDriveAppointment(
          TENANT,
          'someone-else',
          'Queue entry not found',
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        message: 'Queue entry not found',
      });
    });

    it('fails CLOSED for a confined caller who owns no StaffProfile (null is never "unscoped")', async () => {
      actAs(perms(ROLE.DOCTOR));
      staffProfiles.findOne.mockResolvedValueOnce(null);

      await expect(
        service.assertMayDriveAppointment(TENANT, STAFF_ID),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('fails CLOSED when the appointment has no assigned staff at all', async () => {
      actAs(perms(ROLE.DOCTOR));
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

      await expect(
        service.assertMayDriveAppointment(TENANT, undefined),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      await expect(
        service.assertMayDriveAppointment(TENANT, null),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it.each([
      ['nurse', ROLE.NURSE],
      ['receptionist', ROLE.RECEPTIONIST],
      ['owner', ROLE.OWNER],
      ['manager', ROLE.MANAGER],
      ['branch_manager', ROLE.BRANCH_MANAGER],
    ])(
      'does not confine %s: resolves false and runs NO lookup at all (zero cost for unconfined callers)',
      async (_label, role) => {
        actAs(perms(role));

        await expect(
          service.assertMayDriveAppointment(TENANT, 'any-staff'),
        ).resolves.toBe(false);
        expect(redis.application.get).not.toHaveBeenCalled();
        expect(staffProfiles.findOne).not.toHaveBeenCalled();
      },
    );

    it('does not confine a request with no principal (worker job, payment listener, patient self-service)', async () => {
      actAs(null);

      await expect(
        service.assertMayDriveAppointment(TENANT, 'any-staff'),
      ).resolves.toBe(false);
      expect(staffProfiles.findOne).not.toHaveBeenCalled();
    });

    it('resolves the caller in the REQUEST tenant — a doctor who is staff in another tenant owns nothing here', async () => {
      actAs(perms(ROLE.DOCTOR));
      staffProfiles.findOne.mockResolvedValueOnce(null);

      await expect(
        service.assertMayDriveAppointment('other-tenant', STAFF_ID),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(staffProfiles.findOne).toHaveBeenCalledWith({
        where: { user: { id: USER }, tenant: { id: 'other-tenant' } },
        select: { id: true },
      });
    });

    it('a status.update-only custom role (no read, no update) is confined too — fail-closed', async () => {
      actAs([PERMISSION.APPOINTMENTS_STATUS_UPDATE]);
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

      await expect(
        service.assertMayDriveAppointment(TENANT, 'someone-else'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  // ── Provider ↔ patient relationship ──────────────────────────────────────

  describe('hasAppointmentWithCustomer', () => {
    it('is true when the caller’s StaffProfile has a live appointment with the customer, queried by (tenant, staff, customer)', async () => {
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
      appointments.exists.mockResolvedValueOnce(true);

      await expect(
        service.hasAppointmentWithCustomer(TENANT, USER, 'cust-1'),
      ).resolves.toBe(true);
      expect(appointments.exists).toHaveBeenCalledWith({
        where: {
          tenant: { id: TENANT },
          staff: { id: STAFF_ID },
          customer: { id: 'cust-1' },
        },
      });
    });

    it('is false when the caller has no appointment with that customer', async () => {
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
      appointments.exists.mockResolvedValueOnce(false);

      await expect(
        service.hasAppointmentWithCustomer(TENANT, USER, 'cust-2'),
      ).resolves.toBe(false);
    });

    it('is false — WITHOUT querying appointments — when the caller owns no StaffProfile (an Owner/Manager account)', async () => {
      staffProfiles.findOne.mockResolvedValueOnce(null);

      await expect(
        service.hasAppointmentWithCustomer(TENANT, USER, 'cust-1'),
      ).resolves.toBe(false);
      expect(appointments.exists).not.toHaveBeenCalled();
    });

    it('scopes the lookup to the request tenant, so a customer id from another tenant cannot match', async () => {
      staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

      await service.hasAppointmentWithCustomer('t9', USER, 'cust-1');

      expect(appointments.exists).toHaveBeenCalledWith({
        where: expect.objectContaining({ tenant: { id: 't9' } }),
      });
    });
  });
});

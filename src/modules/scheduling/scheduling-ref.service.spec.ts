import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SchedulingRefService } from './scheduling-ref.service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const BRANCH = 'b1';
const STAFF = 's1';

describe('SchedulingRefService', () => {
  let service: SchedulingRefService;
  let branches: MockRepository;
  let staff: MockRepository;
  let schedules: MockRepository;

  beforeEach(async () => {
    branches = createMockRepository();
    staff = createMockRepository();
    schedules = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulingRefService,
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        { provide: getRepositoryToken(StaffSchedule), useValue: schedules },
      ],
    }).compile();
    service = moduleRef.get(SchedulingRefService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getBranch returns a tenant-owned branch', async () => {
    branches.findOne.mockResolvedValueOnce({ id: 'b1', timezone: 'UTC' });
    await expect(service.getBranch(TENANT, 'b1')).resolves.toMatchObject({ id: 'b1' });
  });

  it('assertBranch throws 404 for an unknown branch', async () => {
    branches.findOne.mockResolvedValueOnce(null);
    await expect(service.assertBranch(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('getStaff returns a tenant-owned staff profile', async () => {
    staff.findOne.mockResolvedValueOnce({ id: 's1', is_available_for_booking: true });
    await expect(service.getStaff(TENANT, 's1')).resolves.toMatchObject({ id: 's1' });
  });

  it('assertStaff throws 404 for an unknown staff member', async () => {
    staff.findOne.mockResolvedValueOnce(null);
    await expect(service.assertStaff(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  /**
   * F-4/F-3 — the branch⇄doctor rule. `StaffProfile` has no branch relation; the
   * only structural link is `staff_schedules.branchId`, and it was previously
   * consulted only inside availability computation, which fails OPEN when
   * nothing matches. That made a doctor from another branch bookable anywhere.
   */
  describe('assertStaffAtBranch', () => {
    const bookable = { id: STAFF, is_available_for_booking: true };

    it('allows a doctor with an active schedule at that branch', async () => {
      staff.findOne.mockResolvedValueOnce(bookable);
      schedules.exists.mockResolvedValueOnce(true);
      await expect(service.assertStaffAtBranch(TENANT, BRANCH, STAFF)).resolves.toMatchObject({
        id: STAFF,
      });
    });

    it('rejects a doctor scheduled ELSEWHERE but not at this branch', async () => {
      staff.findOne.mockResolvedValueOnce(bookable);
      schedules.exists
        .mockResolvedValueOnce(false) // at this branch?
        .mockResolvedValueOnce(true); // anywhere in the clinic?
      await expect(service.assertStaffAtBranch(TENANT, BRANCH, STAFF)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('allows a doctor with NO schedules anywhere — unconfigured legacy clinic', async () => {
      staff.findOne.mockResolvedValueOnce(bookable);
      schedules.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      await expect(service.assertStaffAtBranch(TENANT, BRANCH, STAFF)).resolves.toMatchObject({
        id: STAFF,
      });
    });

    it('strict mode rejects that same unconfigured doctor — the public booking rule', async () => {
      staff.findOne.mockResolvedValueOnce(bookable);
      schedules.exists.mockResolvedValueOnce(false);
      await expect(
        service.assertStaffAtBranch(TENANT, BRANCH, STAFF, { strict: true }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('rejects a doctor flagged as not bookable', async () => {
      staff.findOne.mockResolvedValueOnce({ id: STAFF, is_available_for_booking: false });
      await expect(service.assertStaffAtBranch(TENANT, BRANCH, STAFF)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('rejects a soft-deleted doctor', async () => {
      staff.findOne.mockResolvedValueOnce({ ...bookable, deleted_at: new Date() });
      await expect(service.assertStaffAtBranch(TENANT, BRANCH, STAFF)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('rejects a doctor from another clinic (tenant check still first)', async () => {
      staff.findOne.mockResolvedValueOnce(null);
      await expect(service.assertStaffAtBranch(TENANT, BRANCH, STAFF)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});

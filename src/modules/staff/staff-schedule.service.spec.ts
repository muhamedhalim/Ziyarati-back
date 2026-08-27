import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffScheduleService } from './staff-schedule.service';
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
import { WorkingHour } from '../../entities/Staff/WorkingHour';
import { StaffTimeOff } from '../../entities/Staff/StaffTimeOff';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
  MockQueryBuilder,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const BRANCH = 'b1';
// 2026-08-30 is a Sunday (day_of_week 0) — matches the reported repro.
const DATE = '2026-08-30';
const DAY_OF_WEEK = 0;

describe('StaffScheduleService.getAvailability', () => {
  let service: StaffScheduleService;
  let schedules: MockRepository;
  let workingHours: MockRepository;
  let timeOff: MockRepository;
  let staff: MockRepository;
  let branches: MockRepository;
  let branchUsers: MockRepository;
  let scheduleQb: MockQueryBuilder;

  const openBranchHours = [{ start_time: '09:00:00', end_time: '17:00:00' }];

  const liveStaff = (id: string, overrides: Partial<StaffProfile> = {}) =>
    ({
      id,
      title: 'Dr.',
      is_available_for_booking: true,
      user: { full_name: `Staff ${id}` },
      ...overrides,
    }) as StaffProfile;

  beforeEach(async () => {
    schedules = createMockRepository();
    workingHours = createMockRepository();
    timeOff = createMockRepository();
    staff = createMockRepository();
    branches = createMockRepository();
    branchUsers = createMockRepository();

    scheduleQb = createMockQueryBuilder();
    schedules.createQueryBuilder.mockReturnValue(scheduleQb);

    branches.exists.mockResolvedValue(true);
    workingHours.find.mockResolvedValue(openBranchHours);
    timeOff.find.mockResolvedValue([]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffScheduleService,
        { provide: getRepositoryToken(StaffSchedule), useValue: schedules },
        { provide: getRepositoryToken(WorkingHour), useValue: workingHours },
        { provide: getRepositoryToken(StaffTimeOff), useValue: timeOff },
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
      ],
    }).compile();
    service = moduleRef.get(StaffScheduleService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns windows for an employee with a valid schedule', async () => {
    scheduleQb.getMany.mockResolvedValueOnce([
      {
        id: 's1',
        staff: liveStaff('staff-1'),
        start_time: '09:00:00',
        end_time: '13:00:00',
      },
    ]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result.open).toBe(true);
    expect(result.staff).toEqual([
      {
        staffId: 'staff-1',
        title: 'Dr.',
        name: 'Staff staff-1',
        windows: [{ start: '09:00', end: '13:00' }],
      },
    ]);
  });

  it('builds the schedule query with an INNER JOIN on staff (not a LEFT JOIN relation load)', async () => {
    scheduleQb.getMany.mockResolvedValueOnce([]);
    await service.getAvailability(TENANT, BRANCH, DATE);

    // Regression guard: `.find({ relations: { staff: ... } })` compiles to a
    // LEFT JOIN and lets a soft-deleted staff member's schedule row survive
    // with `staff: null` — see the crash this suite is guarding against.
    expect(schedules.createQueryBuilder).toHaveBeenCalledWith('schedule');
    expect(scheduleQb.innerJoinAndSelect).toHaveBeenCalledWith(
      'schedule.staff',
      'staff',
    );
    expect(schedules.find).not.toHaveBeenCalled();
  });

  it('returns an empty staff list when the branch is open but no employee has a schedule that day', async () => {
    scheduleQb.getMany.mockResolvedValueOnce([]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result).toEqual({
      date: DATE,
      branchId: BRANCH,
      dayOfWeek: DAY_OF_WEEK,
      open: true,
      staff: [],
    });
  });

  it('returns open:false without querying schedules when the branch has an EXPLICIT closed row for that day', async () => {
    workingHours.find.mockResolvedValueOnce([
      { start_time: '00:00:00', end_time: '00:00:00', is_closed: true },
    ]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result).toEqual({
      date: DATE,
      branchId: BRANCH,
      dayOfWeek: DAY_OF_WEEK,
      open: false,
      staff: [],
    });
    expect(schedules.createQueryBuilder).not.toHaveBeenCalled();
  });

  // Regression guard for the reported bug: an employee with a recorded
  // Sunday schedule showed "No available times" because `Branch.create()`
  // never seeds `WorkingHour` rows — a branch starts with NONE configured,
  // for any day. The absence of a row must mean "branch hours not
  // configured for this day" (no additional constraint), never "closed" —
  // only an explicit `is_closed: true` row is a real closure.
  it('does NOT treat a day with NO WorkingHour rows at all as closed — the staff\'s own schedule still governs (the reported bug)', async () => {
    workingHours.find.mockResolvedValueOnce([]); // nothing configured for Sunday, at all
    scheduleQb.getMany.mockResolvedValueOnce([
      {
        id: 's1',
        staff: liveStaff('staff-1'),
        start_time: '09:00:00',
        end_time: '13:00:00',
      },
    ]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result.open).toBe(true);
    expect(result.staff).toEqual([
      {
        staffId: 'staff-1',
        title: 'Dr.',
        name: 'Staff staff-1',
        // Not clipped by any branch window — none exist to clip against.
        windows: [{ start: '09:00', end: '13:00' }],
      },
    ]);
    expect((result as { branchHoursConfigured: boolean }).branchHoursConfigured).toBe(false);
  });

  it('still clips staff hours to the branch\'s ACTUAL configured open windows when hours ARE set for the day', async () => {
    workingHours.find.mockResolvedValueOnce([
      { start_time: '09:00:00', end_time: '11:00:00', is_closed: false },
    ]);
    scheduleQb.getMany.mockResolvedValueOnce([
      {
        id: 's1',
        staff: liveStaff('staff-1'),
        // Staff is scheduled 09:00–17:00, but the branch is only open 09–11.
        start_time: '09:00:00',
        end_time: '17:00:00',
      },
    ]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result.staff).toEqual([
      {
        staffId: 'staff-1',
        title: 'Dr.',
        name: 'Staff staff-1',
        windows: [{ start: '09:00', end: '11:00' }],
      },
    ]);
    expect((result as { branchHoursConfigured: boolean }).branchHoursConfigured).toBe(true);
  });

  it('throws NOT_FOUND for an invalid/foreign branch instead of crashing', async () => {
    branches.exists.mockResolvedValueOnce(false);

    await expect(
      service.getAvailability(TENANT, 'no-such-branch', DATE),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(workingHours.find).not.toHaveBeenCalled();
  });

  it('excludes a staff member who is not available for booking, without affecting the others', async () => {
    scheduleQb.getMany.mockResolvedValueOnce([
      {
        id: 's1',
        staff: liveStaff('inactive-staff', { is_available_for_booking: false }),
        start_time: '09:00:00',
        end_time: '13:00:00',
      },
      {
        id: 's2',
        staff: liveStaff('active-staff'),
        start_time: '13:00:00',
        end_time: '17:00:00',
      },
    ]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result.staff.map((s) => s.staffId)).toEqual(['active-staff']);
  });

  it('never crashes on a schedule row with a null staff relationship, and excludes it (defense-in-depth beyond the query fix)', async () => {
    scheduleQb.getMany.mockResolvedValueOnce([
      // Simulates the exact bug: a schedule row whose staff relation did not
      // resolve (soft-deleted / orphaned FK / a future regression back to a
      // LEFT JOIN). Real Postgres traffic can no longer produce this given
      // the INNER JOIN query above, but the service must stay safe even if a
      // caller or a future refactor ever hands it a row shaped like this.
      {
        id: 'ghost-schedule',
        staff: null,
        start_time: '00:00:00',
        end_time: '23:59:00',
      },
      {
        id: 's2',
        staff: liveStaff('active-staff'),
        start_time: '09:00:00',
        end_time: '13:00:00',
      },
    ]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result.staff.map((s) => s.staffId)).toEqual(['active-staff']);
  });

  it('excludes a staff member on approved time off covering the date', async () => {
    scheduleQb.getMany.mockResolvedValueOnce([
      {
        id: 's1',
        staff: liveStaff('staff-on-leave'),
        start_time: '09:00:00',
        end_time: '13:00:00',
      },
    ]);
    timeOff.find.mockResolvedValueOnce([
      {
        staff: { id: 'staff-on-leave' },
        start_date: '2026-08-29',
        end_date: '2026-08-31',
      },
    ]);

    const result = await service.getAvailability(TENANT, BRANCH, DATE);

    expect(result.staff).toEqual([]);
  });

  it('never throws for any of the above scenarios combined (no 500s from this method)', async () => {
    scheduleQb.getMany.mockResolvedValueOnce([
      {
        id: 'ghost',
        staff: null,
        start_time: '00:00:00',
        end_time: '23:59:00',
      },
      {
        id: 's-inactive',
        staff: liveStaff('inactive', { is_available_for_booking: false }),
        start_time: '09:00:00',
        end_time: '13:00:00',
      },
      {
        id: 's-good',
        staff: liveStaff('good'),
        start_time: '09:00:00',
        end_time: '17:00:00',
      },
    ]);

    await expect(
      service.getAvailability(TENANT, BRANCH, DATE),
    ).resolves.toEqual(
      expect.objectContaining({
        staff: [expect.objectContaining({ staffId: 'good' })],
      }),
    );
  });
});

// Regression guard for the other half of the reported bug: a schedule
// created against a branch the staff member isn't even assigned to
// (`branch_users`) is invisible to `getAvailability` (which resolves
// strictly by `StaffSchedule.branch`), while the "New Appointment" employee
// picker filters staff by `branch_users` — the two can silently diverge with
// no error anywhere, and the only symptom is an empty slot grid. This is now
// rejected at write time instead.
describe('StaffScheduleService.createSchedule / updateSchedule — branch assignment guard', () => {
  let service: StaffScheduleService;
  let schedules: MockRepository;
  let workingHours: MockRepository;
  let timeOff: MockRepository;
  let staff: MockRepository;
  let branches: MockRepository;
  let branchUsers: MockRepository;

  const STAFF_ID = 'staff-1';
  const USER_ID = 'user-1';
  const OTHER_BRANCH = 'b2';

  beforeEach(async () => {
    schedules = createMockRepository();
    workingHours = createMockRepository();
    timeOff = createMockRepository();
    staff = createMockRepository();
    branches = createMockRepository();
    branchUsers = createMockRepository();

    staff.exists.mockResolvedValue(true);
    staff.findOne.mockResolvedValue({
      id: STAFF_ID,
      user: { id: USER_ID },
    });
    branches.exists.mockResolvedValue(true);
    schedules.find.mockResolvedValue([]); // no overlapping schedule
    schedules.create.mockImplementation((v: unknown) => v);
    schedules.save.mockImplementation((v: unknown) => Promise.resolve(v));

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffScheduleService,
        { provide: getRepositoryToken(StaffSchedule), useValue: schedules },
        { provide: getRepositoryToken(WorkingHour), useValue: workingHours },
        { provide: getRepositoryToken(StaffTimeOff), useValue: timeOff },
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
      ],
    }).compile();
    service = moduleRef.get(StaffScheduleService);
  });

  afterEach(() => jest.clearAllMocks());

  const dto = {
    branchId: BRANCH,
    dayOfWeek: DAY_OF_WEEK,
    startTime: '09:00',
    endTime: '17:00',
    isActive: true,
  };

  it('allows creating a schedule at a branch the staff member IS assigned to', async () => {
    branchUsers.exists
      .mockResolvedValueOnce(true) // assigned somewhere
      .mockResolvedValueOnce(true); // assigned at this branch

    await expect(
      service.createSchedule(TENANT, STAFF_ID, dto),
    ).resolves.toBeDefined();
  });

  it('rejects creating a schedule at a branch the staff member is assigned elsewhere but NOT here', async () => {
    branchUsers.exists
      .mockResolvedValueOnce(true) // assigned somewhere (OTHER_BRANCH)
      .mockResolvedValueOnce(false); // not assigned at BRANCH

    await expect(
      service.createSchedule(TENANT, STAFF_ID, dto),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      publicContext: { staffId: STAFF_ID, branchId: BRANCH },
    });
    expect(schedules.save).not.toHaveBeenCalled();
  });

  it('allows creating a schedule when the staff member has NO branch assignment at all (legacy/unconfigured data)', async () => {
    branchUsers.exists.mockResolvedValueOnce(false); // assigned nowhere

    await expect(
      service.createSchedule(TENANT, STAFF_ID, dto),
    ).resolves.toBeDefined();
    // Only the "assigned anywhere" check should have run — nothing to
    // compare the branch against.
    expect(branchUsers.exists).toHaveBeenCalledTimes(1);
  });

  it('rejects updating a schedule to move it to a branch the staff member is not assigned to', async () => {
    schedules.findOne.mockResolvedValue({
      id: 'sched-1',
      staff: { id: STAFF_ID },
      branch: { id: BRANCH },
      day_of_week: DAY_OF_WEEK,
      start_time: '09:00:00',
      end_time: '17:00:00',
      is_active: true,
    });
    branchUsers.exists
      .mockResolvedValueOnce(true) // assigned somewhere
      .mockResolvedValueOnce(false); // not assigned at OTHER_BRANCH

    await expect(
      service.updateSchedule(TENANT, STAFF_ID, 'sched-1', {
        branchId: OTHER_BRANCH,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });
});

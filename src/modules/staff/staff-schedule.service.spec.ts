import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffScheduleService } from './staff-schedule.service';
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
import { WorkingHour } from '../../entities/Staff/WorkingHour';
import { StaffTimeOff } from '../../entities/Staff/StaffTimeOff';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Branch } from '../../entities/SaaS-Core/Branch';
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

  it('returns open:false without querying schedules when the branch is closed that day (outside the workday)', async () => {
    workingHours.find.mockResolvedValueOnce([]);

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

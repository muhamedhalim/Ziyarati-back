import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffRatingService } from './staff-rating.service';
import { StaffRating } from '../../entities/Staff/StaffRating';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const STAFF = 'staff-1';

describe('StaffRatingService', () => {
  let service: StaffRatingService;
  let ratings: MockRepository;
  let staff: MockRepository;
  let appointments: MockRepository;

  beforeEach(async () => {
    ratings = createMockRepository();
    staff = createMockRepository();
    appointments = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffRatingService,
        { provide: getRepositoryToken(StaffRating), useValue: ratings },
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
      ],
    }).compile();
    service = moduleRef.get(StaffRatingService);
  });

  afterEach(() => jest.clearAllMocks());

  const completedByStaff = {
    id: 'appt-1',
    status: AppointmentStatus.COMPLETED,
    staff: { id: STAFF },
    customer: { id: 'cust-1' },
  };

  describe('create', () => {
    it('rates a completed appointment handled by the staff member', async () => {
      staff.exists.mockResolvedValueOnce(true);
      appointments.findOne.mockResolvedValueOnce(completedByStaff);
      ratings.findOne.mockResolvedValueOnce(null);
      ratings.save.mockResolvedValueOnce({ id: 'rating-1' });

      await service.create(TENANT, STAFF, { appointmentId: 'appt-1', rating: 5 } as any);
      const created = ratings.create.mock.calls[0][0];
      expect(created.customer).toEqual({ id: 'cust-1' });
    });

    it('rejects an unknown staff member', async () => {
      staff.exists.mockResolvedValueOnce(false);
      await expect(
        service.create(TENANT, STAFF, { appointmentId: 'appt-1', rating: 5 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('rejects a missing appointment', async () => {
      staff.exists.mockResolvedValueOnce(true);
      appointments.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create(TENANT, STAFF, { appointmentId: 'x', rating: 5 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('rejects rating an appointment handled by a different staff member', async () => {
      staff.exists.mockResolvedValueOnce(true);
      appointments.findOne.mockResolvedValueOnce({ ...completedByStaff, staff: { id: 'other' } });
      await expect(
        service.create(TENANT, STAFF, { appointmentId: 'appt-1', rating: 5 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('rejects rating a non-completed appointment', async () => {
      staff.exists.mockResolvedValueOnce(true);
      appointments.findOne.mockResolvedValueOnce({ ...completedByStaff, status: AppointmentStatus.CONFIRMED });
      await expect(
        service.create(TENANT, STAFF, { appointmentId: 'appt-1', rating: 5 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('rejects a duplicate rating for the same (staff, appointment)', async () => {
      staff.exists.mockResolvedValueOnce(true);
      appointments.findOne.mockResolvedValueOnce(completedByStaff);
      ratings.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(
        service.create(TENANT, STAFF, { appointmentId: 'appt-1', rating: 5 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  describe('list', () => {
    it('computes the average rating', async () => {
      staff.exists.mockResolvedValueOnce(true);
      ratings.find.mockResolvedValueOnce([{ rating: 5 }, { rating: 4 }, { rating: 3 }]);
      const res = await service.list(TENANT, STAFF);
      expect(res).toMatchObject({ staffId: STAFF, count: 3, average: 4 });
    });

    it('returns a 0 average with no ratings', async () => {
      staff.exists.mockResolvedValueOnce(true);
      ratings.find.mockResolvedValueOnce([]);
      const res = await service.list(TENANT, STAFF);
      expect(res).toMatchObject({ count: 0, average: 0 });
    });
  });
});

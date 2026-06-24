import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AppointmentReviewService } from './appointment-review.service';
import { CustomerReview } from '../../entities/CRM/CustomerReview';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('AppointmentReviewService', () => {
  let service: AppointmentReviewService;
  let reviews: MockRepository;
  let appointments: MockRepository;

  beforeEach(async () => {
    reviews = createMockRepository();
    appointments = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentReviewService,
        { provide: getRepositoryToken(CustomerReview), useValue: reviews },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
      ],
    }).compile();
    service = moduleRef.get(AppointmentReviewService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    const completed = { id: 'appt-1', status: AppointmentStatus.COMPLETED, customer: { id: 'cust-1' } };

    it('creates a review and derives the customer from the appointment', async () => {
      appointments.findOne.mockResolvedValueOnce(completed);
      reviews.findOne.mockResolvedValueOnce(null);
      reviews.save.mockResolvedValueOnce({ id: 'rev-1' });

      await service.create(TENANT, 'appt-1', { rating: 5, comment: 'great' } as any);

      const created = reviews.create.mock.calls[0][0];
      expect(created.customer).toEqual({ id: 'cust-1' }); // from appointment, not request
      expect(created.rating).toBe(5);
    });

    it('rejects a missing appointment', async () => {
      appointments.findOne.mockResolvedValueOnce(null);
      await expect(service.create(TENANT, 'x', { rating: 5 } as any)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('rejects reviewing a non-completed appointment', async () => {
      appointments.findOne.mockResolvedValueOnce({ ...completed, status: AppointmentStatus.CONFIRMED });
      await expect(service.create(TENANT, 'appt-1', { rating: 5 } as any)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('rejects a second review for the same appointment', async () => {
      appointments.findOne.mockResolvedValueOnce(completed);
      reviews.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create(TENANT, 'appt-1', { rating: 5 } as any)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });
  });

  describe('getForAppointment / findAll / reply', () => {
    it('returns the review for an appointment', async () => {
      reviews.findOne.mockResolvedValueOnce({ id: 'rev-1' });
      await expect(service.getForAppointment(TENANT, 'appt-1')).resolves.toEqual({ id: 'rev-1' });
    });

    it('throws when no review exists for the appointment', async () => {
      reviews.findOne.mockResolvedValueOnce(null);
      await expect(service.getForAppointment(TENANT, 'appt-1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('lists reviews with filters and pagination', async () => {
      reviews.findAndCount.mockResolvedValueOnce([[{ id: 'r1' }], 1]);
      const res = await service.findAll(TENANT, { page: 1, limit: 20, minRating: 4, customerId: 'c1' } as any);
      expect(res).toEqual({ data: [{ id: 'r1' }], total: 1, page: 1, limit: 20 });
    });

    it('attaches a clinic reply to a review', async () => {
      reviews.findOne.mockResolvedValueOnce({ id: 'rev-1' });
      reviews.save.mockImplementationOnce(async (r: any) => r);
      const res = await service.reply(TENANT, 'rev-1', { reply: 'thank you' } as any);
      expect(res).toEqual(expect.objectContaining({ reply: 'thank you' }));
    });

    it('rejects replying to a missing review', async () => {
      reviews.findOne.mockResolvedValueOnce(null);
      await expect(service.reply(TENANT, 'x', { reply: 'hi' } as any)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});

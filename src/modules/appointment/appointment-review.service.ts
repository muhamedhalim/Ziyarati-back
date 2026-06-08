import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, MoreThanOrEqual, Repository } from 'typeorm';

import { CustomerReview } from '../../entities/CRM/CustomerReview';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppointmentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateReviewDto } from './dto/create-review.dto';
import { ReplyReviewDto } from './dto/reply-review.dto';
import { ListReviewsQueryDto } from './dto/list-reviews.query.dto';

/**
 * Customer reviews on appointments.
 *
 * Tenant isolation: every query is filtered by `tenant: { id: tenantId }`; the
 * reviewed appointment is re-loaded under the same tenant, and the review's
 * customer is taken FROM that appointment (never from the request), so a review
 * can never be attached to another clinic's appointment or customer.
 */
@Injectable()
export class AppointmentReviewService {
  constructor(
    @InjectRepository(CustomerReview)
    private readonly reviews: Repository<CustomerReview>,
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
  ) {}

  /** Create a review for a COMPLETED appointment (one per appointment). */
  async create(
    tenantId: string,
    appointmentId: string,
    dto: CreateReviewDto,
  ): Promise<CustomerReview> {
    const appointment = await this.appointments.findOne({
      where: { id: appointmentId, tenant: { id: tenantId } },
      relations: { customer: true },
    });
    if (!appointment) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Appointment not found',
      });
    }

    if (appointment.status !== AppointmentStatus.COMPLETED) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Only completed appointments can be reviewed',
        context: { currentStatus: appointment.status },
      });
    }

    const existing = await this.reviews.findOne({
      where: { appointment: { id: appointmentId }, tenant: { id: tenantId } },
    });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This appointment has already been reviewed',
      });
    }

    const review = this.reviews.create({
      tenant: { id: tenantId } as Tenant,
      customer: { id: appointment.customer.id } as Customer,
      appointment: { id: appointmentId } as Appointment,
      rating: dto.rating,
      comment: dto.comment,
    });
    return this.reviews.save(review);
  }

  /** Get the review for a given appointment (tenant-scoped). */
  async getForAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<CustomerReview> {
    const review = await this.reviews.findOne({
      where: { appointment: { id: appointmentId }, tenant: { id: tenantId } },
      relations: { customer: true },
    });
    if (!review) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No review found for this appointment',
      });
    }
    return review;
  }

  /** Paginated, tenant-scoped review listing with optional filters. */
  async findAll(tenantId: string, query: ListReviewsQueryDto) {
    const where: FindOptionsWhere<CustomerReview> = {
      tenant: { id: tenantId },
    };
    if (query.customerId) where.customer = { id: query.customerId };
    if (query.minRating) where.rating = MoreThanOrEqual(query.minRating);

    const [data, total] = await this.reviews.findAndCount({
      where,
      relations: { customer: true, appointment: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /** Attach (or replace) the clinic's public reply to a review. */
  async reply(
    tenantId: string,
    reviewId: string,
    dto: ReplyReviewDto,
  ): Promise<CustomerReview> {
    const review = await this.reviews.findOne({
      where: { id: reviewId, tenant: { id: tenantId } },
    });
    if (!review) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Review not found' });
    }

    review.reply = dto.reply;
    return this.reviews.save(review);
  }
}

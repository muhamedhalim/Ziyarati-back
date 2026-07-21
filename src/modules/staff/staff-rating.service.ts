import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { StaffRating } from '../../entities/Staff/StaffRating';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppointmentStatus } from '../../entities/enums';

import { AppError, ErrorCode } from '../../common/errors';
import { CreateStaffRatingDto } from './dto/create-staff-rating.dto';

/**
 * Staff ratings, tied to completed appointments.
 *
 * Business rules: only COMPLETED appointments can be rated; the appointment
 * must have been handled by this staff member; one rating per (staff,
 * appointment); the customer is derived from the appointment.
 *
 * Tenant isolation: every query is scoped by `tenant: { id }`.
 */
@Injectable()
export class StaffRatingService {
  constructor(
    @InjectRepository(StaffRating)
    private readonly ratings: Repository<StaffRating>,
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
  ) {}

  async create(
    tenantId: string,
    staffId: string,
    dto: CreateStaffRatingDto,
  ): Promise<StaffRating> {
    await this.assertStaff(tenantId, staffId);

    const appointment = await this.appointments.findOne({
      where: { id: dto.appointmentId, tenant: { id: tenantId } },
      relations: { staff: true, customer: true },
    });
    if (!appointment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Appointment not found' });
    }
    if (appointment.staff?.id !== staffId) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This appointment was not handled by the specified staff member',
      });
    }
    if (appointment.status !== AppointmentStatus.COMPLETED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Only completed appointments can be rated',
        publicContext: { currentStatus: appointment.status },
      });
    }

    const duplicate = await this.ratings.findOne({
      where: {
        staff: { id: staffId },
        appointment: { id: dto.appointmentId },
        tenant: { id: tenantId },
      },
    });
    if (duplicate) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This appointment has already been rated for this staff member',
      });
    }

    const rating = this.ratings.create({
      staff: { id: staffId } as StaffProfile,
      tenant: { id: tenantId } as Tenant,
      appointment: { id: dto.appointmentId } as Appointment,
      customer: appointment.customer
        ? ({ id: appointment.customer.id } as Customer)
        : undefined,
      rating: dto.rating,
      comment: dto.comment,
    });
    return this.ratings.save(rating);
  }

  async list(tenantId: string, staffId: string) {
    await this.assertStaff(tenantId, staffId);

    const data = await this.ratings.find({
      where: { staff: { id: staffId }, tenant: { id: tenantId } },
      relations: { customer: true, appointment: true },
      order: { created_at: 'DESC' },
    });

    const count = data.length;
    const average =
      count === 0
        ? 0
        : +(data.reduce((sum, r) => sum + Number(r.rating), 0) / count).toFixed(2);

    return { staffId, count, average, data };
  }

  private async assertStaff(tenantId: string, staffId: string): Promise<void> {
    const ok = await this.staff.exists({
      where: { id: staffId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
  }
}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Appointment aggregate + its audit children
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService } from '../../entities/Calendar&Appointments/AppointmentService';
import { AppointmentHistory } from '../../entities/Calendar&Appointments/AppointmentHistory';
import { AppointmentStatusLog } from '../../entities/Calendar&Appointments/AppointmentStatusLog';
import { AppointmentNote } from '../../entities/Calendar&Appointments/AppointmentNote';
import { AppointmentReschedule } from '../../entities/Calendar&Appointments/AppointmentReschedule';
import { AppointmentCancellation } from '../../entities/Calendar&Appointments/AppointmentCancellation';

// Reviews + referenced resources (read-only validation: same-tenant checks)
import { CustomerReview } from '../../entities/CRM/CustomerReview';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Service } from '../../entities/Services/Service';

import { SchedulingModule } from '../scheduling/scheduling.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';

import { AppointmentsService } from './appointment.service';
import { AppointmentReviewService } from './appointment-review.service';
import { AppointmentPaymentListener } from './appointment-payment.listener';
import { AppointmentController } from './appointment.controller';
import { ReviewController } from './review.controller';

/**
 * Appointment Domain.
 *
 * Builds on the existing infrastructure:
 *  - RBAC (PermissionsGuard / @RequirePermissions) re-used from AuthModule;
 *  - ActiveTenantGuard + TenantContextService from the global core layer;
 *  - the global JwtAuthGuard (APP_GUARD) authenticates every request.
 *
 * `forFeature` registers the appointment aggregate, its audit tables, the
 * review table, and the referenced resources (branch/customer/staff/service)
 * which the service re-loads with a tenant filter for validation.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Appointment,
      AppointmentService,
      AppointmentHistory,
      AppointmentStatusLog,
      AppointmentNote,
      AppointmentReschedule,
      AppointmentCancellation,
      CustomerReview,
      Branch,
      Customer,
      StaffProfile,
      Service,
    ]),
    // The single availability engine — every booking path validates through it.
    SchedulingModule,
    // Usage-quota enforcement (UsageService) for appointment creation.
    SubscriptionBillingModule,
  ],
  controllers: [AppointmentController, ReviewController],
  // AppointmentPaymentListener bridges verified payment events → booking
  // confirmation (the ONLY payment-driven confirmation path; no redirects).
  providers: [AppointmentsService, AppointmentReviewService, AppointmentPaymentListener],
  exports: [AppointmentsService, AppointmentReviewService],
})
export class AppointmentModule {}

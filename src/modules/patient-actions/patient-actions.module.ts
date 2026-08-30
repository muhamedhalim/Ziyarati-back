import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PatientActionLink } from '../../entities/Calendar&Appointments/PatientActionLink';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { PatientActionLinkService } from './patient-action-link.service';
import { PatientCancellationService } from './patient-cancellation.service';
import { PatientRescheduleService } from './patient-reschedule.service';
import { PatientChangeWindowService } from './patient-change-window.service';
import { PatientActionController } from './patient-action.controller';
import { PatientActionListener } from './patient-action.listener';
import { AppointmentModule } from '../appointment/appointment.module';
import { PaymentsModule } from '../payments/payments.module';
import { SchedulingModule } from '../scheduling/scheduling.module';

/**
 * Spec 014 (Clinic Platform Completion) — patient self-service action links
 * (S1: cancellation, S2: reschedule).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PatientActionLink, TenantSetting]),
    AppointmentModule,
    PaymentsModule,
    SchedulingModule,
  ],
  controllers: [PatientActionController],
  providers: [
    PatientActionLinkService,
    PatientCancellationService,
    PatientRescheduleService,
    PatientChangeWindowService,
    PatientActionListener,
  ],
  exports: [
    PatientActionLinkService,
    PatientCancellationService,
    PatientRescheduleService,
    PatientChangeWindowService,
  ],
})
export class PatientActionsModule {}

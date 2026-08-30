import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PatientActionLink } from '../../entities/Calendar&Appointments/PatientActionLink';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { PatientActionLinkService } from './patient-action-link.service';
import { PatientCancellationService } from './patient-cancellation.service';
import { PatientRescheduleService } from './patient-reschedule.service';
import { PatientChangeWindowService } from './patient-change-window.service';
import {
  PatientActionController,
  WaitlistOfferPublicController,
} from './patient-action.controller';
import { PatientActionListener } from './patient-action.listener';
import { AppointmentModule } from '../appointment/appointment.module';
import { PaymentsModule } from '../payments/payments.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { WaitlistModule } from '../waitlist/waitlist.module';

/**
 * Spec 014 (Clinic Platform Completion) — patient self-service action links
 * (S1: cancellation, S2: reschedule, S9: waitlist offer response — T162).
 *
 * `forwardRef(() => WaitlistModule)` — see `WaitlistModule`'s own docblock
 * for the two-way dependency this closes (`WaitlistOfferService` needs
 * `PatientActionLinkService`; `WaitlistOfferPublicController` here needs
 * `WaitlistOfferService`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PatientActionLink, TenantSetting]),
    AppointmentModule,
    PaymentsModule,
    SchedulingModule,
    forwardRef(() => WaitlistModule),
  ],
  controllers: [PatientActionController, WaitlistOfferPublicController],
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

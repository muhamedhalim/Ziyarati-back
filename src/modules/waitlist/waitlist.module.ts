import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WaitlistEntry } from '../../entities/Calendar&Appointments/WaitlistEntry';
import { WaitlistOffer } from '../../entities/Calendar&Appointments/WaitlistOffer';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { Service } from '../../entities/Services/Service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Branch } from '../../entities/SaaS-Core/Branch';

import { WaitlistService } from './waitlist.service';
import { WaitlistMatcherService } from './waitlist-matcher.service';
import { WaitlistOfferService } from './waitlist-offer.service';
import { WaitlistListener } from './waitlist.listener';
import { WaitlistController } from './waitlist.controller';

import { AppointmentModule } from '../appointment/appointment.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PatientActionsModule } from '../patient-actions/patient-actions.module';
import { AiBotActorModule } from '../ai-bot-actor/ai-bot-actor.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';

/**
 * Spec 014 (Clinic Platform Completion) — appointment waitlist (US9).
 * Scaffolded empty in T006; providers and the controller land here
 * (T156-T161).
 *
 * `forwardRef(() => PatientActionsModule)` — `WaitlistOfferService` needs
 * `PatientActionLinkService` (to issue `WAITLIST_OFFER` links), and
 * `PatientActionsModule` needs `WaitlistOfferService` for the new public
 * offer-response routes added to its EXISTING `patient-action.controller.ts`
 * (T162) — a genuine two-way dependency between these two modules, resolved
 * the same way this codebase already resolves other such cycles (see
 * `ai-bot-actor`/`ai-memory`/`notifications` modules' own `forwardRef` use).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      WaitlistEntry,
      WaitlistOffer,
      Appointment,
      Customer,
      Service,
      StaffProfile,
      Branch,
    ]),
    AppointmentModule,
    SchedulingModule,
    forwardRef(() => PatientActionsModule),
    AiBotActorModule,
    // The single clinic-wide audit INSERT path (ActivityAuditService).
    ActivityLogModule,
  ],
  controllers: [WaitlistController],
  providers: [
    WaitlistService,
    WaitlistMatcherService,
    WaitlistOfferService,
    WaitlistListener,
  ],
  exports: [WaitlistService, WaitlistMatcherService, WaitlistOfferService],
})
export class WaitlistModule {}

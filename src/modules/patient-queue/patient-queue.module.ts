import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { QueueEntry } from '../../entities/Calendar&Appointments/QueueEntry';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';

import { PatientQueueService } from './patient-queue.service';
import { PatientQueueController } from './patient-queue.controller';
import { PatientQueueListener } from './patient-queue.listener';

import { AppointmentModule } from '../appointment/appointment.module';

/**
 * Spec 014 (Clinic Platform Completion) — walk-in / day-of queue management
 * (US10). Named `patient-queue` (not `queue`) to avoid colliding with the
 * infrastructure directory `src/queue/`. Scaffolded empty in T006;
 * providers and the controller land here (T169-T173).
 *
 * `PatientQueueService` is exported so `WorkerModule` can reuse it for the
 * `platform.queueDayClose` sweep (T174) — same "processors reuse existing
 * domain modules" shape as `WaitlistModule`/`PlatformProcessor`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([QueueEntry, Appointment, Branch, BranchUser]),
    AppointmentModule,
  ],
  controllers: [PatientQueueController],
  providers: [PatientQueueService, PatientQueueListener],
  exports: [PatientQueueService],
})
export class PatientQueueModule {}

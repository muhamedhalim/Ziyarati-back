import { Module } from '@nestjs/common';

/**
 * Spec 014 (Clinic Platform Completion) — walk-in / day-of queue management
 * (US10). Named `patient-queue` (not `queue`) to avoid colliding with the
 * infrastructure directory `src/queue/`. Scaffolded empty in T006; providers
 * and the controller land with their own tasks.
 */
@Module({})
export class PatientQueueModule {}

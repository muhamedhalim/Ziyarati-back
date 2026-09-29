import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IntegrationConnection } from '../../entities/Integration/IntegrationConnection';
import { IntegrationIdMap } from '../../entities/Integration/IntegrationIdMap';
import { IntegrationIdempotencyKey } from '../../entities/Integration/IntegrationIdempotencyKey';
import { IntegrationImportJob } from '../../entities/Integration/IntegrationImportJob';
import { IntegrationImportItem } from '../../entities/Integration/IntegrationImportItem';
import { IntegrationSyncJob } from '../../entities/Integration/IntegrationSyncJob';
import { IntegrationConflict } from '../../entities/Integration/IntegrationConflict';
import { IntegrationWebhookEndpoint } from '../../entities/Integration/IntegrationWebhookEndpoint';
import { IntegrationInboundEvent } from '../../entities/Integration/IntegrationInboundEvent';
import { IntegrationStaffProvisioning } from '../../entities/Integration/IntegrationStaffProvisioning';
import { IntegrationOAuthState } from '../../entities/Integration/IntegrationOAuthState';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Customer } from '../../entities/CRM/Customer';
import { Service } from '../../entities/Services/Service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';

import { CryptoModule } from '../../common/crypto/crypto.module';
import { AuthModule } from '../auth/auth.module';
import { CrmModule } from '../crm/crm.module';
import { ServicesModule } from '../services/services.module';
import { StaffModule } from '../staff/staff.module';
import { AppointmentModule } from '../appointment/appointment.module';

import { IntegrationConnectionService } from './connections/integration-connection.service';
import { IntegrationConnectionTestService } from './connections/connection-test.service';
import { IntegrationIdMapService } from './mappings/integration-id-map.service';
import { IntegrationIdempotencyService } from './idempotency/integration-idempotency.service';
import { IntegrationAuditService } from './integration-audit.service';
import { IntegrationUpsertService } from './write/integration-upsert.service';
import { IntegrationImportService } from './imports/integration-import.service';
import { IntegrationImportJobService } from './imports/integration-import-job.service';
import { IntegrationWriteService } from './write/integration-write.service';
import { IntegrationConflictService } from './conflicts/integration-conflict.service';
import { IntegrationConflictResolutionService } from './conflicts/integration-conflict-resolution.service';
import { IntegrationSyncService } from './sync/integration-sync.service';
import { IntegrationProviderService } from './providers/integration-provider.service';
import { IntegrationAdmissionService } from './admission/integration-admission.service';
import { IntegrationServiceAccountService } from './write/integration-service-account.service';
import { IntegrationWebhookEndpointService } from './inbound/integration-webhook-endpoint.service';
import { IntegrationInboundService } from './inbound/integration-inbound.service';
import { IntegrationStaffProvisioningService } from './staff/integration-staff-provisioning.service';
import { IntegrationOAuthService } from './oauth/integration-oauth.service';

import { IntegrationConnectionController } from './connections/integration-connection.controller';
import { IntegrationMappingsController } from './mappings/mappings.controller';
import { IntegrationImportsController } from './imports/imports.controller';
import { IntegrationImportJobsController } from './imports/import-jobs.controller';
import { IntegrationSyncController } from './sync/sync.controller';
import { IntegrationConflictsController } from './conflicts/conflicts.controller';
import { IntegrationInboundEndpointsController } from './inbound/inbound-endpoints.controller';
import { IntegrationInboundWebhookController } from './inbound/inbound-webhook.controller';
import { IntegrationStaffProvisioningController } from './staff/staff-provisioning.controller';
import { IntegrationOAuthController } from './oauth/oauth.controller';

/**
 * Integration Platform — the integration bounded context's application core +
 * tenant-facing management (Phases 3 & 4). Reuses — never rebuilds — the
 * platform module's API-key auth/scopes, encryption, audit log, and the shared
 * BullMQ producer/worker split.
 *
 * Sub-domains (internal folders):
 *  - connections/  connection lifecycle, encrypted credentials, derived health,
 *                  live provider probe, multi-connection-per-tenant isolation.
 *  - mappings/     external-id ⇄ internal-id map (DB-enforced 1:1 per connection).
 *  - write/        the ONE mutation pipeline: source-of-truth/protected-field
 *                  engine + upsert (delegates to domain services) + M2M
 *                  orchestrator. Every inbound path (API, import, sync, webhook,
 *                  conflict resolution) writes through here — no second path.
 *  - idempotency/  retry-safe write dedupe.
 *  - imports/      async queue-based import jobs + items (primary) and the
 *                  bounded synchronous importer (small ops only).
 *  - sync/         queue-based sync engine (cursor/watermark, resume, DB-enforced
 *                  single-active-run-per-tuple).
 *  - conflicts/    persistent conflict store + manual resolution via the shared
 *                  pipeline.
 *  - providers/    provider abstraction (compiled adapters only — no tenant URLs).
 *  - inbound/      connection-scoped, signature-authenticated webhook receiver +
 *                  its queue worker. Verified events are applied by the SAME
 *                  write/ pipeline — there is no second mutation implementation.
 *  - admission/    fail-closed rate/concurrency/size limits for sensitive ops.
 *
 * Worker processors (IntegrationImport/Sync/InboundProcessor) inject the exported
 * job services; enqueues go through the global QueueService.
 *
 * STILL DEFERRED: a real OAuth provider adapter ships when a validated provider
 * config exists.
 */
@Module({
  imports: [
    CryptoModule,
    // RolesService — validates the role an admin picks when APPROVING a staff
    // provisioning request against the tenant's assignable-role catalogue.
    AuthModule,
    CrmModule,
    ServicesModule,
    // Staff upsert delegates to StaffService (update/link only — never creates
    // an account; provisioning stays in StaffAccessService's invitation flow).
    StaffModule,
    // Appointment upsert delegates to AppointmentsService (create/reschedule/
    // cancel) so tenant-scoped reference checks, the real availability re-check
    // and persistence all run inside that service's own transaction.
    AppointmentModule,
    TypeOrmModule.forFeature([
      IntegrationConnection,
      IntegrationIdMap,
      IntegrationIdempotencyKey,
      IntegrationImportJob,
      IntegrationImportItem,
      IntegrationSyncJob,
      IntegrationConflict,
      IntegrationWebhookEndpoint,
      IntegrationInboundEvent,
      IntegrationStaffProvisioning,
      IntegrationOAuthState,
      AuditLog,
      User,
      Customer,
      Service,
      StaffProfile,
      Appointment,
    ]),
  ],
  controllers: [
    IntegrationConnectionController,
    IntegrationMappingsController,
    IntegrationImportsController,
    IntegrationImportJobsController,
    IntegrationSyncController,
    IntegrationConflictsController,
    IntegrationInboundEndpointsController,
    // PUBLIC (signature-authenticated) receiver — see the controller docstring.
    IntegrationInboundWebhookController,
    IntegrationStaffProvisioningController,
    IntegrationOAuthController,
  ],
  providers: [
    IntegrationConnectionService,
    IntegrationConnectionTestService,
    IntegrationIdMapService,
    IntegrationIdempotencyService,
    IntegrationAuditService,
    IntegrationUpsertService,
    IntegrationImportService,
    IntegrationImportJobService,
    IntegrationWriteService,
    IntegrationConflictService,
    IntegrationConflictResolutionService,
    IntegrationSyncService,
    IntegrationProviderService,
    IntegrationAdmissionService,
    IntegrationServiceAccountService,
    IntegrationWebhookEndpointService,
    IntegrationInboundService,
    IntegrationStaffProvisioningService,
    IntegrationOAuthService,
  ],
  exports: [
    IntegrationWriteService,
    IntegrationConnectionService,
    IntegrationIdMapService,
    IntegrationImportJobService,
    IntegrationSyncService,
    IntegrationConflictService,
    IntegrationProviderService,
    IntegrationInboundService,
    IntegrationServiceAccountService,
    IntegrationStaffProvisioningService,
    IntegrationOAuthService,
    // The worker's retention sweep purges expired idempotency records.
    IntegrationIdempotencyService,
  ],
})
export class IntegrationPlatformModule {}

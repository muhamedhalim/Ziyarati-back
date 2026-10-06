import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StorageModule } from '../storage/storage.module';
import { MedicalRecordsModule } from '../medical-records/medical-records.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';

import { Customer } from '../../entities/CRM/Customer';
import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { CustomerAddress } from '../../entities/CRM/CustomerAddress';
import { CustomerNote } from '../../entities/CRM/CustomerNote';
import { CustomerTag } from '../../entities/CRM/CustomerTag';
import { CustomerTagRelation } from '../../entities/CRM/CustomerTagRelation';
import { CustomerFile } from '../../entities/CRM/CustomerFile';
import { CustomerSegment } from '../../entities/CRM/CustomerSegment';

import { CustomerService } from './customer.service';
import { CustomerProfileService } from './customer-profile.service';
import { CustomerAddressService } from './customer-address.service';
import { CustomerNoteService } from './customer-note.service';
import { CustomerTagService } from './customer-tag.service';
import { CustomerTagRelationService } from './customer-tag-relation.service';
import { CustomerFileService } from './customer-file.service';
import { CustomerImportService } from './customer-import.service';
import { SegmentQueryBuilder } from './segment-query.builder';
import { CustomerSegmentService } from './customer-segment.service';

import { CustomerController } from './customer.controller';
import { CustomerProfileController } from './customer-profile.controller';
import { CustomerAddressController } from './customer-address.controller';
import { CustomerNoteController } from './customer-note.controller';
import { CustomerTagController } from './customer-tag.controller';
import { CustomerTagRelationController } from './customer-tag-relation.controller';
import { CustomerFileController } from './customer-file.controller';
import { CustomerImportController } from './customer-import.controller';
import { CustomerSegmentController } from './customer-segment.controller';

/**
 * CRM Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService (tenant scope), and the global
 * JwtAuthGuard. Every resource is strictly tenant-scoped via the `tenant`
 * relation; the tenant always comes from TenantContext, never from request input.
 *
 * Relationship map: Customer is the aggregate root — 1:1 profile, 1:N addresses /
 * notes / files, and M:N tags via CustomerTagRelation. Sub-resource services
 * verify the parent customer (and tag) are tenant-owned before any write.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Customer,
      CustomerProfile,
      CustomerAddress,
      CustomerNote,
      CustomerTag,
      CustomerTagRelation,
      CustomerFile,
      CustomerSegment,
    ]),
    StorageModule,
    // Read-audit of D4 reads (profile, notes, files) — residency plan P14. Acyclic:
    // MedicalRecordsModule imports only ActivityLogModule.
    MedicalRecordsModule,
    // `max_customers` is a plan cap enforced at `CustomerService.create`.
    // Acyclic: SubscriptionBillingModule imports only PlatformModule.
    SubscriptionBillingModule,
  ],
  controllers: [
    CustomerController,
    CustomerProfileController,
    CustomerAddressController,
    CustomerNoteController,
    CustomerTagController,
    CustomerTagRelationController,
    CustomerFileController,
    CustomerImportController,
    CustomerSegmentController,
  ],
  providers: [
    CustomerService,
    CustomerProfileService,
    CustomerAddressService,
    CustomerNoteService,
    CustomerTagService,
    CustomerTagRelationService,
    CustomerFileService,
    CustomerImportService,
    SegmentQueryBuilder,
    CustomerSegmentService,
  ],
  // `CustomerNoteService` is reused (not duplicated) by the Live Agent Handover
  // feature's internal notes — a note added during a handover is a first-class
  // CRM note against the conversation's customer. `CustomerSegmentService` is
  // exported for `CampaignsModule` (segment-aware fan-out, Phase 10 T125).
  exports: [CustomerService, CustomerNoteService, CustomerSegmentService],
})
export class CrmModule {}

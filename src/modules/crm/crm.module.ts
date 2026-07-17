import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StorageModule } from '../storage/storage.module';

import { Customer } from '../../entities/CRM/Customer';
import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { CustomerAddress } from '../../entities/CRM/CustomerAddress';
import { CustomerNote } from '../../entities/CRM/CustomerNote';
import { CustomerTag } from '../../entities/CRM/CustomerTag';
import { CustomerTagRelation } from '../../entities/CRM/CustomerTagRelation';
import { CustomerFile } from '../../entities/CRM/CustomerFile';

import { CustomerService } from './customer.service';
import { CustomerProfileService } from './customer-profile.service';
import { CustomerAddressService } from './customer-address.service';
import { CustomerNoteService } from './customer-note.service';
import { CustomerTagService } from './customer-tag.service';
import { CustomerTagRelationService } from './customer-tag-relation.service';
import { CustomerFileService } from './customer-file.service';

import { CustomerController } from './customer.controller';
import { CustomerProfileController } from './customer-profile.controller';
import { CustomerAddressController } from './customer-address.controller';
import { CustomerNoteController } from './customer-note.controller';
import { CustomerTagController } from './customer-tag.controller';
import { CustomerTagRelationController } from './customer-tag-relation.controller';
import { CustomerFileController } from './customer-file.controller';

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
    ]),
    StorageModule,
  ],
  controllers: [
    CustomerController,
    CustomerProfileController,
    CustomerAddressController,
    CustomerNoteController,
    CustomerTagController,
    CustomerTagRelationController,
    CustomerFileController,
  ],
  providers: [
    CustomerService,
    CustomerProfileService,
    CustomerAddressService,
    CustomerNoteService,
    CustomerTagService,
    CustomerTagRelationService,
    CustomerFileService,
  ],
  // `CustomerNoteService` is reused (not duplicated) by the Live Agent Handover
  // feature's internal notes — a note added during a handover is a first-class
  // CRM note against the conversation's customer.
  exports: [CustomerService, CustomerNoteService],
})
export class CrmModule {}

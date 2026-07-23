import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IntegrationConnection } from '../../entities/Integration/IntegrationConnection';
import { IntegrationIdMap } from '../../entities/Integration/IntegrationIdMap';
import { IntegrationIdempotencyKey } from '../../entities/Integration/IntegrationIdempotencyKey';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Customer } from '../../entities/CRM/Customer';
import { Service } from '../../entities/Services/Service';

import { CryptoModule } from '../../common/crypto/crypto.module';
import { CrmModule } from '../crm/crm.module';
import { ServicesModule } from '../services/services.module';

import { IntegrationConnectionService } from './integration-connection.service';
import { IntegrationIdMapService } from './integration-id-map.service';
import { IntegrationIdempotencyService } from './integration-idempotency.service';
import { IntegrationAuditService } from './integration-audit.service';
import { IntegrationUpsertService } from './integration-upsert.service';
import { IntegrationImportService } from './integration-import.service';
import { IntegrationWriteService } from './integration-write.service';

import { IntegrationConnectionController } from './integration-connection.controller';
import { IntegrationDataController } from './integration-data.controller';

/**
 * Integration Platform (Phase 3 — two-way integrations).
 *
 * Adds the WRITE half of the integration platform on top of Phase 1 (read API +
 * API keys) and Phase 2 (outbound webhooks), reusing — never rebuilding — their
 * auth, tenant guards, scopes, audit, encryption and DTO patterns.
 *
 * Wired capabilities:
 *  - IntegrationConnection lifecycle (CRUD/activate/deactivate/disconnect/health),
 *    encrypted credentials, multi-connection-per-tenant isolation.
 *  - External-id ⇄ internal-id mapping with DB-enforced uniqueness + dedupe.
 *  - Idempotency-Key store (retry-safe writes; payload-mismatch rejection).
 *  - Source-of-truth / protected-field engine (mass-assignment defense).
 *  - Scoped write/upsert pipeline (customers, services) that DELEGATES to the
 *    existing domain services (CustomerService/ServiceService) so all business
 *    rules are reused — no repository writes here.
 *  - Bounded synchronous batch import (dry-run + partial success + counts).
 *
 * DELIBERATELY NOT YET INCLUDED (later phases): async import worker, sync
 * engine/cursors, conflict persistence + resolution UI, import/sync history
 * tables, connection-scoped inbound webhooks, OAuth provider abstraction, and
 * staff/appointment write (identity/lifecycle handling).
 *
 * IntegrationWriteService is exported so the M2M write controllers in
 * IntegrationModule can share the exact same write path.
 */
@Module({
  imports: [
    CryptoModule,
    CrmModule,
    ServicesModule,
    TypeOrmModule.forFeature([
      IntegrationConnection,
      IntegrationIdMap,
      IntegrationIdempotencyKey,
      AuditLog,
      Customer,
      Service,
    ]),
  ],
  controllers: [IntegrationConnectionController, IntegrationDataController],
  providers: [
    IntegrationConnectionService,
    IntegrationIdMapService,
    IntegrationIdempotencyService,
    IntegrationAuditService,
    IntegrationUpsertService,
    IntegrationImportService,
    IntegrationWriteService,
  ],
  exports: [IntegrationWriteService, IntegrationConnectionService, IntegrationIdMapService],
})
export class IntegrationPlatformModule {}

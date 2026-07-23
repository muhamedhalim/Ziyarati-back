import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { plainToInstance, ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';

import { Customer } from '../../../entities/CRM/Customer';
import { Service } from '../../../entities/Services/Service';
import { AppError, ErrorCode } from '../../../common/errors';
import { CustomerService } from '../../crm/customer.service';
import { CreateCustomerDto } from '../../crm/dto/create-customer.dto';
import { UpdateCustomerDto } from '../../crm/dto/update-customer.dto';
import { ServiceService } from '../../services/service.service';
import { CreateServiceDto } from '../../services/dto/create-service.dto';
import { UpdateServiceDto } from '../../services/dto/update-service.dto';

import {
  INTEGRATION_RESOURCE,
  IntegrationResource,
  MAPPING_SOURCE,
  UPSERT_OUTCOME,
  UpsertOutcome,
} from '../integration-platform.constants';
import { decideConflict, sanitizeExternalInput } from './source-of-truth';
import { IntegrationIdMapService } from '../mappings/integration-id-map.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';
import { IntegrationConflictService } from '../conflicts/integration-conflict.service';

export interface UpsertResult {
  outcome: UpsertOutcome;
  externalId: string;
  internalId: string | null;
  changedFields?: string[];
  /** Present only when outcome is FAILED — a safe, per-record error summary. */
  error?: string;
}

export interface UpsertActor {
  userId?: string;
  ip?: string;
}

/**
 * Maps one resource type onto its EXISTING domain service so all business rules
 * (uniqueness, validation, category/lifecycle checks) are reused — the upsert
 * pipeline never writes to a repository directly. The two repositories injected
 * below are used for READ-ONLY natural-key dedupe lookups only.
 */
interface ResourceAdapter {
  createDto: ClassConstructor<object>;
  updateDto: ClassConstructor<object>;
  create(tenantId: string, data: Record<string, unknown>): Promise<{ id: string }>;
  update(tenantId: string, id: string, data: Record<string, unknown>): Promise<{ id: string }>;
  /** Comparable (allowlist-keyed) current view, or null if the record is gone. */
  currentView(tenantId: string, id: string): Promise<Record<string, unknown> | null>;
  /** Existing internal record matching the external record's natural key, or null. */
  naturalMatch(tenantId: string, data: Record<string, unknown>): Promise<{ id: string } | null>;
}

/**
 * The two-way WRITE pipeline (Phase 3). For one external record it:
 *   1. sanitises the payload (rejects platform-protected fields),
 *   2. resolves the mapping (external id ⇄ internal id) for the connection,
 *   3. on an existing mapping → applies the connection's conflict policy,
 *   4. on no mapping → dedupes against the natural key (link) or creates,
 *   5. validates against the real domain DTO and writes via the domain service,
 *   6. records/updates the id mapping and audits the result.
 *
 * Processing is IDEMPOTENT and safely retryable (never claims exactly-once):
 * the mapping makes a repeated upsert of the same external id a no-op update.
 */
@Injectable()
export class IntegrationUpsertService {
  private readonly logger = new Logger(IntegrationUpsertService.name);
  private readonly adapters: Record<IntegrationResource, ResourceAdapter | undefined>;

  constructor(
    private readonly customers: CustomerService,
    private readonly servicesSvc: ServiceService,
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
    @InjectRepository(Service) private readonly serviceRepo: Repository<Service>,
    private readonly idMap: IntegrationIdMapService,
    private readonly connections: IntegrationConnectionService,
    private readonly audit: IntegrationAuditService,
    private readonly conflicts: IntegrationConflictService,
  ) {
    this.adapters = {
      [INTEGRATION_RESOURCE.CUSTOMER]: this.customerAdapter(),
      [INTEGRATION_RESOURCE.SERVICE]: this.serviceAdapter(),
      // Staff & appointment upsert require identity/lifecycle handling and are
      // implemented in a later phase (see the module docstring).
      [INTEGRATION_RESOURCE.STAFF]: undefined,
      [INTEGRATION_RESOURCE.APPOINTMENT]: undefined,
    };
  }

  /** Whether write/import is currently supported for a resource. */
  supports(resource: IntegrationResource): boolean {
    return !!this.adapters[resource];
  }

  /**
   * Upsert one external record. `connection` must already be resolved as ACTIVE
   * (the controller does this once for a batch). Never throws for a per-record
   * business failure in `safe` mode — returns an outcome instead — so a batch
   * import can continue past a bad row.
   */
  async upsertOne(
    tenantId: string,
    resource: IntegrationResource,
    connectionId: string,
    conflictPolicy: string,
    externalId: string,
    rawData: Record<string, unknown>,
    actor: UpsertActor,
    opts: { safe?: boolean; dryRun?: boolean } = {},
  ): Promise<UpsertResult> {
    try {
      return await this.run(tenantId, resource, connectionId, conflictPolicy, externalId, rawData, actor, {
        dryRun: opts.dryRun,
      });
    } catch (err) {
      if (!opts.safe) throw err;
      // Safe (batch) mode: convert to a per-record failure the caller can report.
      const message = err instanceof AppError ? err.message : 'Record failed to import';
      return { outcome: UPSERT_OUTCOME.FAILED, externalId, internalId: null, error: message };
    }
  }

  private async run(
    tenantId: string,
    resource: IntegrationResource,
    connectionId: string,
    conflictPolicy: string,
    externalId: string,
    rawData: Record<string, unknown>,
    actor: UpsertActor,
    opts: { dryRun?: boolean } = {},
  ): Promise<UpsertResult> {
    const dryRun = !!opts.dryRun;
    const adapter = this.adapters[resource];
    if (!adapter) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Write is not yet supported for resource "${resource}"`,
      });
    }

    const { clean } = sanitizeExternalInput(resource, rawData);

    const mapping = await this.idMap.findByExternalId(tenantId, connectionId, resource, externalId);

    // ── Known mapping → update under the conflict policy ──────────────────
    if (mapping) {
      const current = await adapter.currentView(tenantId, mapping.internal_resource_id);
      if (!current) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'The mapped internal record no longer exists',
        });
      }
      const decision = decideConflict(conflictPolicy as never, clean, current);
      if (decision.report) {
        if (!dryRun) {
          await this.conflicts.record({
            tenantId, connectionId, resource, externalId,
            internalId: mapping.internal_resource_id,
            changedFields: decision.changedFields, policy: conflictPolicy,
            externalValues: clean, platformValues: current,
          });
        }
        return this.conflicted(externalId, mapping.internal_resource_id, decision.changedFields);
      }
      if (!decision.apply) {
        return { outcome: UPSERT_OUTCOME.SKIPPED, externalId, internalId: mapping.internal_resource_id };
      }
      await this.validateOrThrow(adapter.updateDto, clean);
      if (dryRun) {
        return { outcome: UPSERT_OUTCOME.UPDATED, externalId, internalId: mapping.internal_resource_id, changedFields: decision.changedFields };
      }
      const updated = await adapter.update(tenantId, mapping.internal_resource_id, clean);
      await this.audit.record(INTEGRATION_AUDIT_ACTION.UPSERT, tenantId, resource, updated.id, actor, {
        connectionId, externalId, outcome: UPSERT_OUTCOME.UPDATED, changedFields: decision.changedFields,
      });
      return { outcome: UPSERT_OUTCOME.UPDATED, externalId, internalId: updated.id, changedFields: decision.changedFields };
    }

    // ── No mapping → dedupe against the natural key, else create ──────────
    const existing = await adapter.naturalMatch(tenantId, clean);
    if (existing) {
      const current = (await adapter.currentView(tenantId, existing.id)) ?? {};
      const decision = decideConflict(conflictPolicy as never, clean, current);
      if (decision.apply) await this.validateOrThrow(adapter.updateDto, clean);

      if (dryRun) {
        if (decision.report) return this.conflicted(externalId, existing.id, decision.changedFields);
        if (decision.apply) return { outcome: UPSERT_OUTCOME.UPDATED, externalId, internalId: existing.id, changedFields: decision.changedFields };
        return { outcome: UPSERT_OUTCOME.LINKED, externalId, internalId: existing.id };
      }

      // Link the mapping (dedup) then apply policy against the existing record.
      await this.idMap.link(tenantId, connectionId, resource, externalId, existing.id, MAPPING_SOURCE.PLATFORM);
      await this.audit.record(INTEGRATION_AUDIT_ACTION.MAPPING_LINK, tenantId, resource, existing.id, actor, {
        connectionId, externalId,
      });
      if (decision.report) {
        await this.conflicts.record({
          tenantId, connectionId, resource, externalId, internalId: existing.id,
          changedFields: decision.changedFields, policy: conflictPolicy,
          externalValues: clean, platformValues: current,
        });
        return this.conflicted(externalId, existing.id, decision.changedFields);
      }
      if (decision.apply) {
        await adapter.update(tenantId, existing.id, clean);
        return { outcome: UPSERT_OUTCOME.UPDATED, externalId, internalId: existing.id, changedFields: decision.changedFields };
      }
      return { outcome: UPSERT_OUTCOME.LINKED, externalId, internalId: existing.id };
    }

    await this.validateOrThrow(adapter.createDto, clean);
    if (dryRun) {
      return { outcome: UPSERT_OUTCOME.CREATED, externalId, internalId: null };
    }
    const created = await adapter.create(tenantId, clean);
    await this.idMap.link(tenantId, connectionId, resource, externalId, created.id, MAPPING_SOURCE.EXTERNAL);
    await this.audit.record(INTEGRATION_AUDIT_ACTION.UPSERT, tenantId, resource, created.id, actor, {
      connectionId, externalId, outcome: UPSERT_OUTCOME.CREATED,
    });
    return { outcome: UPSERT_OUTCOME.CREATED, externalId, internalId: created.id };
  }

  private conflicted(externalId: string, internalId: string, changedFields: string[]): UpsertResult {
    return { outcome: UPSERT_OUTCOME.CONFLICTED, externalId, internalId, changedFields };
  }

  /** Reuse the domain DTO's own class-validator rules (never duplicated here). */
  private async validateOrThrow(dtoClass: ClassConstructor<object>, data: Record<string, unknown>): Promise<void> {
    const instance = plainToInstance(dtoClass, data, { enableImplicitConversion: false });
    const errors = await validate(instance as object, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      const fields = errors.map((e) => e.property);
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'External record failed validation',
        publicContext: { fields },
      });
    }
  }

  // ── Resource adapters ────────────────────────────────────────────────────

  private customerAdapter(): ResourceAdapter {
    return {
      createDto: CreateCustomerDto,
      updateDto: UpdateCustomerDto,
      create: async (tenantId, data) => this.customers.create(tenantId, data as unknown as CreateCustomerDto),
      update: async (tenantId, id, data) => this.customers.update(tenantId, id, data as UpdateCustomerDto),
      currentView: async (tenantId, id) => {
        const c = await this.customerRepo.findOne({ where: { id, tenant: { id: tenantId } } });
        if (!c) return null;
        return {
          full_name: c.full_name ?? null,
          phone: c.phone,
          email: c.email,
          gender: c.gender ?? null,
          date_of_birth: c.date_of_birth ?? null,
          source: c.source ?? null,
          marketing_opt_in: c.marketing_opt_in,
          is_active: c.is_active,
        };
      },
      naturalMatch: async (tenantId, data) => {
        const phone = data.phone as string | undefined;
        if (!phone) return null;
        const c = await this.customerRepo.findOne({ where: { tenant: { id: tenantId }, phone } });
        return c ? { id: c.id } : null;
      },
    };
  }

  private serviceAdapter(): ResourceAdapter {
    return {
      createDto: CreateServiceDto,
      updateDto: UpdateServiceDto,
      create: async (tenantId, data) => this.servicesSvc.create(tenantId, data as unknown as CreateServiceDto),
      update: async (tenantId, id, data) => this.servicesSvc.update(tenantId, id, data as UpdateServiceDto),
      currentView: async (tenantId, id) => {
        const s = await this.serviceRepo.findOne({ where: { id, tenant: { id: tenantId } }, relations: { category: true } });
        if (!s) return null;
        return {
          name: s.name,
          description: s.description ?? null,
          durationMinutes: s.duration_minutes,
          pricingType: s.pricing_type,
          basePrice: s.base_price ?? null,
          isActive: s.is_active,
          categoryId: s.category?.id ?? null,
        };
      },
      naturalMatch: async (tenantId, data) => {
        const name = data.name as string | undefined;
        if (!name) return null;
        const s = await this.serviceRepo.findOne({ where: { tenant: { id: tenantId }, name, deleted_at: IsNull() } });
        return s ? { id: s.id } : null;
      },
    };
  }
}

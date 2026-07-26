import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, MoreThan, Repository } from 'typeorm';
import { plainToInstance, ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';

import { Customer } from '../../../entities/CRM/Customer';
import { Service } from '../../../entities/Services/Service';
import { StaffProfile } from '../../../entities/Staff/StaffProfile';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { AppError, ErrorCode } from '../../../common/errors';
import { CustomerService } from '../../crm/customer.service';
import { CreateCustomerDto } from '../../crm/dto/create-customer.dto';
import { UpdateCustomerDto } from '../../crm/dto/update-customer.dto';
import { ServiceService } from '../../services/service.service';
import { CreateServiceDto } from '../../services/dto/create-service.dto';
import { UpdateServiceDto } from '../../services/dto/update-service.dto';
import { StaffService as StaffDomainService } from '../../staff/staff.service';
import { UpdateStaffDto } from '../../staff/dto/update-staff.dto';
import { AppointmentsService } from '../../appointment/appointment.service';
import { CreateAppointmentDto } from '../../appointment/dto/create-appointment.dto';

import {
  CONFLICT_REASON,
  ConflictReason,
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
import { IntegrationStaffProvisioningService } from '../staff/integration-staff-provisioning.service';

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
 * Per-operation context handed to an adapter. `raw` is the ORIGINAL payload so an
 * adapter can read READ-ONLY hints (staff `matchEmail`, appointment
 * `*ExternalId` / `action` / `reason`) that are deliberately not writable;
 * `connectionId` scopes any mapping lookups the adapter needs.
 */
export interface AdapterContext {
  actor: UpsertActor;
  raw: Record<string, unknown>;
  connectionId: string;
}

/** One internal record changed since the outbound cursor, with its own resume point. */
export interface DirtyInternalRow {
  internalId: string;
  /** Opaque — "resume strictly after this row". Never parsed by the caller. */
  cursor: string;
}
export interface DirtyInternalPage {
  rows: DirtyInternalRow[];
  hasMore: boolean;
}

/** UUID shape check — API-key principals (`apikey:<id>`) are NOT real users. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Outbound cursor codec — `{updated_at ISO}|{id}` so a resume point can break a
 * tie between two records with the identical millisecond timestamp. Opaque to
 * every caller outside this file (the sync engine stores/replays it verbatim).
 */
function encodeOutboundCursor(updatedAt: Date, id: string): string {
  return `${updatedAt.toISOString()}|${id}`;
}
function decodeOutboundCursor(raw: string): { ts: Date; id: string } | null {
  const idx = raw.indexOf('|');
  if (idx <= 0) return null;
  const ts = new Date(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (Number.isNaN(ts.getTime()) || !id) return null;
  return { ts, id };
}

/**
 * Appointments record real ownership (`booked_by`/`cancelled_by` are user FKs),
 * so a write must be attributable to a real platform user. An API-key principal
 * is not one — such a write is refused rather than corrupting ownership.
 */
function requireActorUser(actor: UpsertActor): string {
  const id = actor?.userId;
  if (!id || !UUID_RE.test(id)) {
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message:
        'Appointment writes must be attributable to a platform user — run this import from the dashboard rather than a machine-to-machine key',
    });
  }
  return id;
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
  /**
   * When false, this resource may NEVER be created by an integration — an
   * unmapped, unmatched external record raises a reviewable CONFLICT instead.
   * Used by staff, where creating a record would require provisioning a user
   * account (a privileged action that must go through the invitation flow).
   */
  canCreate?: boolean;
  /**
   * Skip the generic pre-validation against `createDto`/`updateDto`.
   *
   * Needed by appointments: their required references arrive as READ-ONLY
   * `*ExternalId` hints that only the adapter can resolve into internal ids, so
   * validating the sanitized payload against `CreateAppointmentDto` beforehand
   * would reject every hint-based record for "missing customerId" before the
   * mapping lookup ever ran. Nothing is lost by skipping it — the adapter
   * delegates to the domain lifecycle service, which applies the very same DTO
   * validation (plus tenant-scoped reference checks and the availability
   * re-check) inside its own transaction.
   */
  validatesInAdapter?: boolean;
  /**
   * True when the payload asks for a LIFECYCLE transition that is not visible as
   * a field diff.
   *
   * `decideConflict` compares allowlisted VALUES, so a cancel — which carries no
   * writable field at all, only the read-only `action`/`reason` hints — produces
   * an empty diff and would otherwise be skipped as "nothing changed". A
   * lifecycle request is an instruction, not a value, so the adapter must still
   * be invoked. It remains subject to the domain lifecycle's own rules, which
   * reject a transition that is not allowed.
   */
  hasLifecycleIntent?(raw: Record<string, unknown>): boolean;
  /** Reason code recorded when `canCreate` is false. */
  cannotCreateReason?: ConflictReason;
  /**
   * Optional hook fired when creation was blocked, so a resource with a REVIEW
   * QUEUE (staff) can enqueue an actionable request alongside the conflict.
   * Must never throw — the conflict is already the durable record.
   */
  onCreateBlocked?(
    tenantId: string,
    clean: Record<string, unknown>,
    ctx: AdapterContext,
    externalId: string,
  ): Promise<void>;
  create(tenantId: string, data: Record<string, unknown>, ctx: AdapterContext): Promise<{ id: string }>;
  update(tenantId: string, id: string, data: Record<string, unknown>, ctx: AdapterContext): Promise<{ id: string }>;
  /** Comparable (allowlist-keyed) current view, or null if the record is gone. */
  currentView(tenantId: string, id: string): Promise<Record<string, unknown> | null>;
  /**
   * Existing internal record matching the external record's natural key, or null.
   * `clean` is the sanitized (writable) payload; `raw` is the original request so
   * an adapter can read a READ-ONLY match hint (e.g. staff's `matchEmail`) that
   * is deliberately not writable. Returning null for an AMBIGUOUS match is
   * required — never guess between candidates.
   */
  naturalMatch(
    tenantId: string,
    clean: Record<string, unknown>,
    raw: Record<string, unknown>,
  ): Promise<{ id: string } | null>;
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
    private readonly staffSvc: StaffDomainService,
    private readonly appointmentsSvc: AppointmentsService,
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
    @InjectRepository(Service) private readonly serviceRepo: Repository<Service>,
    @InjectRepository(StaffProfile) private readonly staffRepo: Repository<StaffProfile>,
    @InjectRepository(Appointment) private readonly appointmentRepo: Repository<Appointment>,
    private readonly idMap: IntegrationIdMapService,
    private readonly connections: IntegrationConnectionService,
    private readonly audit: IntegrationAuditService,
    private readonly conflicts: IntegrationConflictService,
    // Staff-only review queue. Optional so the pipeline still constructs (and
    // unit-tests) without it; the conflict remains the durable record either way.
    @Optional() private readonly staffProvisioning?: IntegrationStaffProvisioningService,
  ) {
    this.adapters = {
      [INTEGRATION_RESOURCE.CUSTOMER]: this.customerAdapter(),
      [INTEGRATION_RESOURCE.SERVICE]: this.serviceAdapter(),
      [INTEGRATION_RESOURCE.STAFF]: this.staffAdapter(),
      [INTEGRATION_RESOURCE.APPOINTMENT]: this.appointmentAdapter(),
    };
  }

  /** Whether write/import is currently supported for a resource. */
  supports(resource: IntegrationResource): boolean {
    return !!this.adapters[resource];
  }

  /**
   * Internal records changed since `cursorRaw` (outbound sync's own
   * changed-since scan) — ordered `(updated_at, id)` so a resume point is
   * always unambiguous even when two rows share a timestamp. Bounded to
   * `limit` rows per call (the sync engine pages through this exactly like an
   * inbound provider page). Reuses the SAME repositories already injected for
   * natural-key dedupe reads; the actual outbound payload for each row comes
   * from {@link currentViewOf} (the existing allowlisted projection), so no
   * new "what can be sent externally" logic is introduced here.
   */
  async listDirtyInternal(
    tenantId: string,
    resource: IntegrationResource,
    cursorRaw: string | null,
    limit: number,
  ): Promise<DirtyInternalPage> {
    switch (resource) {
      case INTEGRATION_RESOURCE.CUSTOMER:
        return this.listDirtyRows(this.customerRepo, tenantId, cursorRaw, limit);
      case INTEGRATION_RESOURCE.SERVICE:
        return this.listDirtyRows(this.serviceRepo, tenantId, cursorRaw, limit);
      case INTEGRATION_RESOURCE.STAFF:
        return this.listDirtyRows(this.staffRepo, tenantId, cursorRaw, limit);
      case INTEGRATION_RESOURCE.APPOINTMENT:
        return this.listDirtyRows(this.appointmentRepo, tenantId, cursorRaw, limit);
      default:
        return { rows: [], hasMore: false };
    }
  }

  private async listDirtyRows<T extends { id: string; updated_at?: Date }>(
    repo: Repository<T>,
    tenantId: string,
    cursorRaw: string | null,
    limit: number,
  ): Promise<DirtyInternalPage> {
    const decoded = cursorRaw ? decodeOutboundCursor(cursorRaw) : null;
    if (cursorRaw && !decoded) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Outbound sync cursor is invalid' });
    }

    const base = { tenant: { id: tenantId } } as unknown as FindOptionsWhere<T>;
    const where: FindOptionsWhere<T>[] = decoded
      ? [
          { ...base, updated_at: MoreThan(decoded.ts) } as unknown as FindOptionsWhere<T>,
          { ...base, updated_at: decoded.ts, id: MoreThan(decoded.id) } as unknown as FindOptionsWhere<T>,
        ]
      : [base];

    const rows = await repo.find({
      where,
      order: { updated_at: 'ASC', id: 'ASC' } as never,
      take: limit + 1, // one extra to learn `hasMore` without a second count query
      select: { id: true, updated_at: true } as never,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      hasMore,
      rows: page.map((r) => {
        const row = r as unknown as { id: string; updated_at: Date };
        return { internalId: row.id, cursor: encodeOutboundCursor(row.updated_at, row.id) };
      }),
    };
  }

  /**
   * The comparable (allowlist-keyed) current view of an internal record, or null
   * if it no longer exists. Exposed so conflict resolution can detect that the
   * platform record MOVED ON since the conflict was raised — without duplicating
   * any adapter knowledge. Contains only allowlisted fields, never protected ones.
   */
  async currentViewOf(
    tenantId: string,
    resource: IntegrationResource,
    internalId: string,
  ): Promise<Record<string, unknown> | null> {
    const adapter = this.adapters[resource];
    if (!adapter) return null;
    return adapter.currentView(tenantId, internalId);
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
      // A LIFECYCLE request (cancel / reschedule) is an instruction, not a value,
      // so it carries no field diff and must not be mistaken for "nothing
      // changed". The domain lifecycle still rejects a transition it disallows.
      const lifecycle = !!adapter.hasLifecycleIntent?.(rawData ?? {});
      if (decision.report && !lifecycle) {
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
      if (!decision.apply && !lifecycle) {
        return { outcome: UPSERT_OUTCOME.SKIPPED, externalId, internalId: mapping.internal_resource_id };
      }
      if (!adapter.validatesInAdapter) await this.validateOrThrow(adapter.updateDto, clean);
      if (dryRun) {
        return { outcome: UPSERT_OUTCOME.UPDATED, externalId, internalId: mapping.internal_resource_id, changedFields: decision.changedFields };
      }
      const updated = await adapter.update(tenantId, mapping.internal_resource_id, clean, { actor, raw: rawData ?? {}, connectionId });
      await this.audit.record(INTEGRATION_AUDIT_ACTION.UPSERT, tenantId, resource, updated.id, actor, {
        connectionId, externalId, outcome: UPSERT_OUTCOME.UPDATED, changedFields: decision.changedFields,
      });
      return { outcome: UPSERT_OUTCOME.UPDATED, externalId, internalId: updated.id, changedFields: decision.changedFields };
    }

    // ── No mapping → dedupe against the natural key, else create ──────────
    const existing = await adapter.naturalMatch(tenantId, clean, rawData ?? {});
    if (existing) {
      const current = (await adapter.currentView(tenantId, existing.id)) ?? {};
      const decision = decideConflict(conflictPolicy as never, clean, current);
      if (decision.apply && !adapter.validatesInAdapter) {
        await this.validateOrThrow(adapter.updateDto, clean);
      }

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
        await adapter.update(tenantId, existing.id, clean, { actor, raw: rawData ?? {}, connectionId });
        return { outcome: UPSERT_OUTCOME.UPDATED, externalId, internalId: existing.id, changedFields: decision.changedFields };
      }
      return { outcome: UPSERT_OUTCOME.LINKED, externalId, internalId: existing.id };
    }

    // ── No mapping, no natural match → create (unless creation is forbidden) ──
    if (adapter.canCreate === false) {
      // Creating this resource would require a privileged platform action (e.g.
      // provisioning a user account for staff). Raise a reviewable conflict
      // instead of silently creating anything.
      if (!dryRun) {
        await this.conflicts.record({
          tenantId, connectionId, resource, externalId, internalId: null,
          changedFields: Object.keys(clean), policy: conflictPolicy,
          externalValues: clean, platformValues: {},
          reason: adapter.cannotCreateReason ?? CONFLICT_REASON.MISSING_DEPENDENCY,
        });
        // …and, where the resource has a review queue, enqueue an ACTIONABLE
        // request so the admin can approve/link/reject rather than only seeing
        // that something failed. Best-effort: the conflict above is the record
        // of truth, so a hiccup here must not fail the import.
        await adapter.onCreateBlocked?.(tenantId, clean, {
          actor, raw: rawData ?? {}, connectionId,
        }, externalId);
      }
      return {
        outcome: UPSERT_OUTCOME.CONFLICTED,
        externalId,
        internalId: null,
        changedFields: Object.keys(clean),
        error: 'No matching internal record; creating this resource from an integration is not permitted',
      };
    }

    if (!adapter.validatesInAdapter) await this.validateOrThrow(adapter.createDto, clean);
    if (dryRun) {
      return { outcome: UPSERT_OUTCOME.CREATED, externalId, internalId: null };
    }
    const created = await adapter.create(tenantId, clean, { actor, raw: rawData ?? {}, connectionId });
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

  /**
   * Appointments — routed exclusively through the appointment LIFECYCLE service
   * (`create` / `reschedule` / `cancel`), never a raw row write. That service
   * validates branch/customer/staff/services within the tenant, re-checks REAL
   * availability, and does it all inside ONE transaction, so a double-booking or
   * an invalid combination can never be produced by an integration.
   *
   * Dependencies are resolved to internal ids from the connection's mapping using
   * read-only `*ExternalId` hints (an external PMS knows its own ids, not ours).
   * Internal uuids may also be supplied directly — the lifecycle service
   * tenant-validates them either way. If ANY dependency cannot be resolved the
   * record fails safely with a `missing_dependency` conflict; nothing partial is
   * written because the whole create runs in the service's transaction.
   *
   * Lifecycle intent is carried by the read-only `action` hint:
   *   `cancel`     → AppointmentsService.cancel   (reason only; refunds are
   *                  platform-owned and never externally settable)
   *   `reschedule` → AppointmentsService.reschedule (availability re-checked)
   *   default      → create (new) / reschedule-on-time-change (existing)
   * A transition the lifecycle forbids surfaces as a safe failure, never a
   * forced status write.
   */
  private appointmentAdapter(): ResourceAdapter {
    /** Resolve one dependency: explicit internal id, else mapping lookup. */
    const resolveRef = async (
      tenantId: string,
      connectionId: string,
      resource: IntegrationResource,
      internalId: unknown,
      externalId: unknown,
    ): Promise<string | null> => {
      if (typeof internalId === 'string' && internalId) return internalId;
      if (typeof externalId === 'string' && externalId) {
        const m = await this.idMap.findByExternalId(tenantId, connectionId, resource, externalId);
        return m?.internal_resource_id ?? null;
      }
      return null;
    };

    const missingDependency = (what: string): never => {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Cannot resolve the ${what} for this appointment — import or map it first`,
        publicContext: { reason: CONFLICT_REASON.MISSING_DEPENDENCY },
      });
    };

    const resolveServiceIds = async (
      tenantId: string,
      connectionId: string,
      internal: unknown,
      external: unknown,
    ): Promise<string[] | undefined> => {
      if (Array.isArray(internal) && internal.length) return internal as string[];
      if (!Array.isArray(external) || !external.length) return undefined;
      const ids: string[] = [];
      for (const ext of external) {
        if (typeof ext !== 'string') continue;
        const m = await this.idMap.findByExternalId(
          tenantId, connectionId, INTEGRATION_RESOURCE.SERVICE, ext,
        );
        if (!m) missingDependency('service');
        ids.push((m as { internal_resource_id: string }).internal_resource_id);
      }
      return ids;
    };

    return {
      createDto: CreateAppointmentDto,
      updateDto: CreateAppointmentDto,
      // Dependencies arrive as read-only `*ExternalId` hints that only this
      // adapter can resolve, so generic pre-validation would reject every
      // hint-based record before the mapping lookup. The lifecycle service
      // applies the same DTO validation inside its own transaction.
      validatesInAdapter: true,
      // `cancel` carries no writable field, so without this the empty diff would
      // be read as "nothing changed" and the cancellation silently skipped.
      hasLifecycleIntent: (raw) => {
        const action = typeof raw.action === 'string' ? raw.action.toLowerCase() : '';
        return action === 'cancel' || action === 'reschedule';
      },
      create: async (tenantId, data, ctx) => {
        const userId = requireActorUser(ctx.actor);
        const branchId = await resolveRef(
          tenantId, ctx.connectionId, INTEGRATION_RESOURCE.APPOINTMENT, data.branchId, ctx.raw.branchExternalId,
        );
        const customerId = await resolveRef(
          tenantId, ctx.connectionId, INTEGRATION_RESOURCE.CUSTOMER, data.customerId, ctx.raw.customerExternalId,
        );
        const staffId = await resolveRef(
          tenantId, ctx.connectionId, INTEGRATION_RESOURCE.STAFF, data.staffId, ctx.raw.staffExternalId,
        );
        if (!branchId) missingDependency('branch');
        if (!customerId) missingDependency('customer');
        if (!staffId) missingDependency('staff');
        const serviceIds = await resolveServiceIds(
          tenantId, ctx.connectionId, data.serviceIds, ctx.raw.serviceExternalIds,
        );

        // Delegated wholesale: tenant-scoped reference checks, the REAL
        // availability re-check and persistence all happen inside the
        // appointment service's own transaction — so a double-booking or an
        // invalid staff/service/branch combination can never be produced here.
        const created = await this.appointmentsSvc.create(tenantId, userId, {
          branchId,
          customerId,
          staffId,
          startAt: data.startAt,
          endAt: data.endAt,
          serviceIds,
          notes: data.notes,
        } as unknown as CreateAppointmentDto);
        return { id: created.id };
      },
      update: async (tenantId, id, data, ctx) => {
        const userId = requireActorUser(ctx.actor);
        const action = typeof ctx.raw.action === 'string' ? ctx.raw.action.toLowerCase() : '';
        const reason = typeof ctx.raw.reason === 'string' ? ctx.raw.reason.slice(0, 1000) : undefined;

        if (action === 'cancel') {
          // Reason only — refunds/amounts/settlement are platform-owned and are
          // never settable by an external system.
          await this.appointmentsSvc.cancel(tenantId, userId, id, { reason } as never);
          return { id };
        }

        if (action === 'reschedule' || data.startAt !== undefined) {
          if (!data.startAt) {
            throw new AppError(ErrorCode.VALIDATION_ERROR, {
              message: 'A new start time is required to reschedule this appointment',
            });
          }
          // Lifecycle guards (not-terminal) + availability re-check run inside
          // the service's transaction.
          await this.appointmentsSvc.reschedule(tenantId, userId, id, {
            newStartAt: data.startAt,
            newEndAt: data.endAt,
            reason,
          } as never);
          return { id };
        }

        // Nothing lifecycle-relevant changed — a no-op beats a raw row write
        // that would bypass the lifecycle rules.
        return { id };
      },
      currentView: async (tenantId, id) => {
        const a = await this.appointmentRepo.findOne({
          where: { id, tenant: { id: tenantId } },
          relations: { staff: true, branch: true, customer: true },
        });
        if (!a) return null;
        return {
          startAt: a.start_at ? new Date(a.start_at).toISOString() : null,
          endAt: a.end_at ? new Date(a.end_at).toISOString() : null,
          staffId: a.staff?.id ?? null,
          customerId: a.customer?.id ?? null,
          branchId: a.branch?.id ?? null,
        };
      },
      // An external appointment id is the ONLY safe identity: matching by
      // time+staff would silently hijack an unrelated booking.
      naturalMatch: async () => null,
    };
  }

  /**
   * Staff — UPDATE/LINK ONLY. A StaffProfile is bound to exactly one User for
   * life, so creating one from an integration would mean provisioning a login
   * account: a privileged action that must go through the platform's existing
   * invitation flow (StaffAccessService.grant), never an external system. Hence
   * `canCreate: false` — an unmapped, unmatched external staff record raises a
   * reviewable conflict instead of creating anything.
   *
   * Natural matching is by the LINKED USER'S EMAIL, exact and tenant-scoped, and
   * only ever produces a MAPPING (it never touches the user, its roles, its
   * access state, or any money/reputation field). An ambiguous match (more than
   * one profile) is refused rather than guessed.
   */
  private staffAdapter(): ResourceAdapter {
    return {
      createDto: UpdateStaffDto, // never used — creation is forbidden below
      updateDto: UpdateStaffDto,
      canCreate: false,
      cannotCreateReason: CONFLICT_REASON.STAFF_REQUIRES_ACCOUNT,
      create: async () => {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'Staff cannot be created by an integration — invite the member through the platform, then re-run the import to link them',
        });
      },
      update: async (tenantId, id, data) =>
        this.staffSvc.update(tenantId, id, data as UpdateStaffDto),
      currentView: async (tenantId, id) => {
        const s = await this.staffRepo.findOne({ where: { id, tenant: { id: tenantId } } });
        if (!s) return null;
        return {
          title: s.title ?? null,
          bio: s.bio ?? null,
          isAvailableForBooking: s.is_available_for_booking,
          bookingBufferMinutes: s.booking_buffer_minutes,
        };
      },
      naturalMatch: async (tenantId, _clean, raw) => {
        // `matchEmail` is a READ-ONLY matching hint: not writable (so it can
        // never change an account's email) and not protected (so sending it is
        // not treated as an attack). Used solely to find the staff member to link.
        const matches = await this.matchStaffByEmail(tenantId, raw);
        if (matches.length !== 1) return null; // 0 = no match, >1 = ambiguous → never guess
        return { id: matches[0].id };
      },
      /**
       * No account exists for this external staff member. Rather than only
       * failing, enqueue a REVIEWABLE provisioning request carrying the proposed
       * identity + allowlisted profile fields (and any ambiguous candidates), so
       * an admin can approve (choosing the role), link, or reject. Nothing about
       * an account is created or changed here.
       */
      onCreateBlocked: async (tenantId, clean, ctx, externalId) => {
        const candidates = await this.matchStaffByEmail(tenantId, ctx.raw);
        await this.staffProvisioning
          ?.record({
            tenantId,
            connectionId: ctx.connectionId,
            externalId,
            fullName: typeof ctx.raw.fullName === 'string' ? ctx.raw.fullName : null,
            email: typeof ctx.raw.matchEmail === 'string' ? ctx.raw.matchEmail : null,
            profile: clean,
            candidateStaffIds: candidates.map((c) => c.id),
          })
          .catch((e) =>
            this.logger.warn(`staff provisioning enqueue failed: ${(e as Error)?.message}`),
          );
      },
    };
  }

  /** Exact, tenant-scoped staff lookup by the read-only `matchEmail` hint. */
  private async matchStaffByEmail(
    tenantId: string,
    raw: Record<string, unknown>,
  ): Promise<Array<{ id: string }>> {
    const email = typeof raw.matchEmail === 'string' ? raw.matchEmail.trim().toLowerCase() : '';
    if (!email) return [];
    return this.staffRepo.find({
      where: { tenant: { id: tenantId }, user: { email } },
      relations: { user: true },
      take: 2,
      select: { id: true },
    });
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

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { createHash } from 'node:crypto';

import { IntegrationConflict } from '../../../entities/Integration/IntegrationConflict';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { User } from '../../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../../common/errors';

import {
  CONFLICT_REASON,
  CONFLICT_RESOLUTION,
  CONFLICT_STATUS,
  ConflictReason,
  ConflictResolution,
  IntegrationResource,
} from '../integration-platform.constants';
import { QueryConflictsDto } from '../dto/query-conflicts.dto';

export interface RecordConflictInput {
  tenantId: string;
  connectionId: string;
  resource: IntegrationResource;
  externalId: string;
  internalId: string | null;
  changedFields: string[];
  policy: string;
  /** Sanitized incoming external values (allowlisted only). */
  externalValues: Record<string, unknown>;
  /** Current platform values (allowlisted view). */
  platformValues: Record<string, unknown>;
  /** Safe machine-readable reason code. Defaults to field divergence. */
  reason?: ConflictReason;
}

/**
 * Persistent conflict store (Phase 4). Repository-only on purpose — it records,
 * lists, and transitions conflicts but never re-applies data (that goes through
 * the shared write pipeline in IntegrationConflictResolutionService), so this
 * service has NO dependency on the upsert pipeline and no dependency cycle.
 *
 * Only SAFE data is persisted: ids, the NAMES of conflicting fields, and short
 * one-way hashes of each side's values. The actual (possibly sensitive/protected)
 * values are never stored or exposed.
 */
@Injectable()
export class IntegrationConflictService {
  private readonly logger = new Logger(IntegrationConflictService.name);

  constructor(
    @InjectRepository(IntegrationConflict)
    private readonly repo: Repository<IntegrationConflict>,
  ) {}

  /** Short, safe one-way hash of the changed fields' values (no values stored). */
  static hashValues(fields: string[], obj: Record<string, unknown>): string {
    const subset = fields
      .slice()
      .sort()
      .map((f) => `${f}=${stableScalar(obj[f])}`)
      .join('');
    return createHash('sha256').update(subset).digest('hex').slice(0, 64);
  }

  /**
   * Record (or refresh) a pending conflict for one external record. Deduplicated
   * on (tenant, connection, resource, external_id, status=pending): a repeated
   * divergence updates the existing pending row rather than piling up duplicates.
   * Best-effort — a persistence failure must never break the write it accompanies.
   */
  async record(input: RecordConflictInput): Promise<IntegrationConflict | null> {
    try {
      const externalHash = IntegrationConflictService.hashValues(input.changedFields, input.externalValues);
      const platformHash = IntegrationConflictService.hashValues(input.changedFields, input.platformValues);

      const existing = await this.repo.findOne({
        where: {
          tenant: { id: input.tenantId },
          connection: { id: input.connectionId },
          resource_type: input.resource,
          external_id: input.externalId,
          status: CONFLICT_STATUS.PENDING,
        },
      });

      if (existing) {
        existing.conflicting_fields = input.changedFields;
        existing.internal_resource_id = input.internalId;
        existing.external_hash = externalHash;
        existing.platform_hash = platformHash;
        existing.policy = input.policy;
        existing.reason = input.reason ?? CONFLICT_REASON.FIELD_DIVERGENCE;
        return this.repo.save(existing);
      }

      return await this.repo.save(
        this.repo.create({
          tenant: { id: input.tenantId } as Tenant,
          connection: { id: input.connectionId } as IntegrationConnection,
          resource_type: input.resource,
          external_id: input.externalId,
          internal_resource_id: input.internalId,
          conflicting_fields: input.changedFields,
          external_hash: externalHash,
          platform_hash: platformHash,
          policy: input.policy,
          reason: input.reason ?? CONFLICT_REASON.FIELD_DIVERGENCE,
          status: CONFLICT_STATUS.PENDING,
        }),
      );
    } catch (err) {
      this.logger.warn(`conflict record failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  async list(tenantId: string, query: QueryConflictsDto) {
    const where: FindOptionsWhere<IntegrationConflict> = { tenant: { id: tenantId } };
    if (query.connectionId) where.connection = { id: query.connectionId };
    if (query.resourceType) where.resource_type = query.resourceType;
    where.status = query.status ?? CONFLICT_STATUS.PENDING;

    const [rows, total] = await this.repo.findAndCount({
      where,
      relations: { connection: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data: rows.map((c) => this.toView(c)), total, page: query.page, limit: query.limit };
  }

  async getOrThrow(tenantId: string, id: string): Promise<IntegrationConflict> {
    const c = await this.repo.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { connection: true },
    });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Conflict not found' });
    return c;
  }

  /** Mark a conflict resolved (the data change, if any, is applied by the caller). */
  async markResolved(
    tenantId: string,
    id: string,
    resolution: ConflictResolution,
    resolverId?: string,
  ): Promise<IntegrationConflict> {
    const c = await this.getOrThrow(tenantId, id);
    if (c.status !== CONFLICT_STATUS.PENDING) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Conflict is already resolved' });
    }
    c.status = resolution === CONFLICT_RESOLUTION.IGNORED ? CONFLICT_STATUS.IGNORED : CONFLICT_STATUS.RESOLVED;
    c.resolution = resolution;
    c.resolved_by = resolverId ? ({ id: resolverId } as User) : null;
    c.resolved_at = new Date();
    return this.repo.save(c);
  }

  private toView(c: IntegrationConflict) {
    return {
      id: c.id,
      connectionId: c.connection?.id ?? null,
      resourceType: c.resource_type,
      externalId: c.external_id,
      internalResourceId: c.internal_resource_id ?? null,
      conflictingFields: c.conflicting_fields,
      /** True when the two sides still differ (safe hash comparison — no values). */
      stillDiffers: !!c.external_hash && !!c.platform_hash && c.external_hash !== c.platform_hash,
      policy: c.policy,
      reason: c.reason,
      status: c.status,
      resolution: c.resolution ?? null,
      resolvedBy: c.resolved_by?.id ?? null,
      resolvedAt: c.resolved_at ?? null,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    };
  }
}

/** Stable scalar rendering for hashing (mirrors the upsert value comparison). */
function stableScalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return String(v.getTime());
  return String(v).trim();
}

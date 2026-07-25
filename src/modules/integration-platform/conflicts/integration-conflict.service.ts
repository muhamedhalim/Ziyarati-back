import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
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
  OPEN_CONFLICT_STATUSES,
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

      // Dedupe against ANY still-open state, not just `pending` — a `stale`
      // conflict is unresolved, so a fresh divergence must REFRESH it rather
      // than pile a second open row on top of it. (The partial unique index
      // covers the same set, so a race collapses the same way.)
      const existing = await this.repo.findOne({
        where: {
          tenant: { id: input.tenantId },
          connection: { id: input.connectionId },
          resource_type: input.resource,
          external_id: input.externalId,
          status: In(OPEN_CONFLICT_STATUSES),
        },
      });

      if (existing) {
        existing.conflicting_fields = input.changedFields;
        existing.internal_resource_id = input.internalId;
        existing.external_hash = externalHash;
        existing.platform_hash = platformHash;
        existing.policy = input.policy;
        existing.reason = input.reason ?? CONFLICT_REASON.FIELD_DIVERGENCE;
        // A refreshed snapshot supersedes staleness: both sides are current
        // again, so the conflict returns to the actionable queue. A row someone
        // is actively RESOLVING is left claimed — stealing the claim mid-apply
        // is exactly the race the claim exists to prevent.
        if (existing.status === CONFLICT_STATUS.STALE) {
          existing.status = CONFLICT_STATUS.PENDING;
        }
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
    // Default to every state still needing a decision — a `stale` conflict is
    // unresolved and must not disappear from the queue just because its status
    // is no longer literally `pending`.
    const status = query.status ?? 'open';
    where.status = status === 'open' ? In(OPEN_CONFLICT_STATUSES) : status;

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

  /**
   * ATOMIC CLAIM. Moves pending|stale → `resolving` with a CONDITIONAL update and
   * reports whether THIS caller won. Two resolvers pressing "resolve" at the same
   * moment cannot both proceed: exactly one update matches, the other gets false
   * and is told the conflict is already being resolved. A service-level
   * "is it still pending?" read could not give this guarantee.
   */
  async claim(tenantId: string, id: string): Promise<boolean> {
    const res = await this.repo
      .createQueryBuilder()
      .update(IntegrationConflict)
      .set({ status: CONFLICT_STATUS.RESOLVING })
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('status IN (:...open)', {
        open: [CONFLICT_STATUS.PENDING, CONFLICT_STATUS.STALE],
      })
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /** Release a claim back to `pending` when the resolution could not be applied. */
  async release(tenantId: string, id: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(IntegrationConflict)
      .set({ status: CONFLICT_STATUS.PENDING })
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('status = :resolving', { resolving: CONFLICT_STATUS.RESOLVING })
      .execute()
      .catch((e) => this.logger.warn(`conflict release failed: ${(e as Error)?.message}`));
  }

  /**
   * The internal record moved on since the conflict was raised. Refresh the
   * platform-side hash to the CURRENT values and park the conflict as `stale` so
   * a reviewer re-reads it — the recorded external snapshot is never applied on
   * top of a record that has since changed.
   */
  async markStale(
    tenantId: string,
    id: string,
    currentPlatformHash: string | null,
  ): Promise<IntegrationConflict> {
    const c = await this.getOrThrow(tenantId, id);
    c.status = CONFLICT_STATUS.STALE;
    c.platform_hash = currentPlatformHash;
    c.stale_attempts += 1;
    c.last_stale_at = new Date();
    return this.repo.save(c);
  }

  /**
   * Mark a claimed conflict resolved. Only a conflict this caller has CLAIMED
   * (status `resolving`) can be completed, so a late/duplicate submit after
   * someone else finished cannot overwrite the recorded outcome.
   */
  async markResolved(
    tenantId: string,
    id: string,
    resolution: ConflictResolution,
    resolverId?: string,
  ): Promise<IntegrationConflict> {
    const res = await this.repo
      .createQueryBuilder()
      .update(IntegrationConflict)
      .set({
        status:
          resolution === CONFLICT_RESOLUTION.IGNORED ? CONFLICT_STATUS.IGNORED : CONFLICT_STATUS.RESOLVED,
        resolution,
        resolved_by: resolverId ? ({ id: resolverId } as User) : null,
        resolved_at: new Date(),
      })
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('status = :resolving', { resolving: CONFLICT_STATUS.RESOLVING })
      .execute();

    if ((res.affected ?? 0) === 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This conflict was already resolved by someone else',
      });
    }
    return this.getOrThrow(tenantId, id);
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
      /** True when the platform record moved on and the snapshot can't be applied. */
      isStale: c.status === CONFLICT_STATUS.STALE,
      staleAttempts: c.stale_attempts ?? 0,
      lastStaleAt: c.last_stale_at ?? null,
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

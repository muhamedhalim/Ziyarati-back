import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, IsNull, Not, Repository } from 'typeorm';

import { IntegrationIdMap } from '../../../entities/Integration/IntegrationIdMap';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';

import {
  IntegrationResource,
  MAPPING_SOURCE,
  MappingSource,
  UNLINK_REASON,
  UnlinkReason,
} from '../integration-platform.constants';
import { QueryMappingsDto } from '../dto/query-mappings.dto';

/** Internal ids are UUID columns — only an exact match is valid against them. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * External-id ⇄ internal-id mapping (Phase 3). Every read/write is scoped to a
 * (tenant, connection, resource_type) so two external systems — or two tenants —
 * can never see or overwrite each other's mappings. The DB unique constraints
 * (see the migration) are the real guarantee; this service surfaces clean
 * conflicts and never mutates a mapping's `internal_resource_id` to a different
 * record (a remap attempt is rejected, not silently applied).
 */
@Injectable()
export class IntegrationIdMapService {
  private readonly logger = new Logger(IntegrationIdMapService.name);

  constructor(
    @InjectRepository(IntegrationIdMap)
    private readonly repo: Repository<IntegrationIdMap>,
  ) {}

  /**
   * Look up the ACTIVE internal id an external id maps to (or null). Unlinked
   * rows are excluded: they are history, not a live correspondence.
   */
  findByExternalId(
    tenantId: string,
    connectionId: string,
    resource: IntegrationResource,
    externalId: string,
  ): Promise<IntegrationIdMap | null> {
    return this.repo.findOne({
      where: {
        tenant: { id: tenantId },
        connection: { id: connectionId },
        resource_type: resource,
        external_id: externalId,
        unlinked_at: IsNull(),
      },
    });
  }

  /** Look up the external id a given internal record is actively mapped to (or null). */
  findByInternalId(
    tenantId: string,
    connectionId: string,
    resource: IntegrationResource,
    internalId: string,
  ): Promise<IntegrationIdMap | null> {
    return this.repo.findOne({
      where: {
        tenant: { id: tenantId },
        connection: { id: connectionId },
        resource_type: resource,
        internal_resource_id: internalId,
        unlinked_at: IsNull(),
      },
    });
  }

  /**
   * A previously-unlinked mapping for this external id, newest first. Used on
   * reconnect so a returning external record REUSES its original internal record
   * instead of creating a duplicate.
   */
  findHistorical(
    tenantId: string,
    connectionId: string,
    resource: IntegrationResource,
    externalId: string,
  ): Promise<IntegrationIdMap | null> {
    return this.repo.findOne({
      where: {
        tenant: { id: tenantId },
        connection: { id: connectionId },
        resource_type: resource,
        external_id: externalId,
        unlinked_at: Not(IsNull()),
      },
      order: { unlinked_at: 'DESC' },
    });
  }

  /**
   * Create a mapping, tolerating a concurrent duplicate. Returns the existing
   * row if one already covers this external id (idempotent link). Rejects 409 if
   * the external id is already mapped to a DIFFERENT internal record, or the
   * internal record is already mapped to a different external id — an
   * inconsistent remap that must never be applied silently.
   */
  async link(
    tenantId: string,
    connectionId: string,
    resource: IntegrationResource,
    externalId: string,
    internalId: string,
    source: MappingSource = MAPPING_SOURCE.EXTERNAL,
  ): Promise<IntegrationIdMap> {
    const byExternal = await this.findByExternalId(tenantId, connectionId, resource, externalId);
    if (byExternal) {
      if (byExternal.internal_resource_id !== internalId) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'External id is already mapped to a different internal record',
        });
      }
      return byExternal;
    }
    const byInternal = await this.findByInternalId(tenantId, connectionId, resource, internalId);
    if (byInternal && byInternal.external_id !== externalId) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Internal record is already mapped to a different external id',
      });
    }

    // REUSE a historical mapping when the same pairing returns (e.g. after an
    // unlink, or when an external system re-sends a record post-reconnect).
    // Re-activating preserves the original correspondence instead of creating a
    // duplicate internal record on the next import.
    const historical = await this.findHistorical(tenantId, connectionId, resource, externalId);
    if (historical && historical.internal_resource_id === internalId) {
      historical.unlinked_at = null;
      historical.unlink_reason = null;
      try {
        return await this.repo.save(historical);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Someone re-linked it concurrently — fall through to the normal path.
      }
    }

    try {
      return await this.repo.save(
        this.repo.create({
          tenant: { id: tenantId } as Tenant,
          connection: { id: connectionId } as IntegrationConnection,
          resource_type: resource,
          external_id: externalId,
          internal_resource_id: internalId,
          source,
        }),
      );
    } catch (err) {
      // Lost the race — another request just created this exact mapping.
      if (isUniqueViolation(err)) {
        const existing = await this.findByExternalId(tenantId, connectionId, resource, externalId);
        if (existing && existing.internal_resource_id === internalId) return existing;
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'Mapping conflicts with an existing mapping for this connection',
        });
      }
      throw err;
    }
  }

  async list(tenantId: string, query: QueryMappingsDto) {
    const base: FindOptionsWhere<IntegrationIdMap> = { tenant: { id: tenantId } };
    if (query.connectionId) base.connection = { id: query.connectionId };
    if (query.resourceType) base.resource_type = query.resourceType;
    // Exact id lookups (either side) — the common "where did this record go?" case.
    if (query.externalId) base.external_id = query.externalId;
    if (query.internalResourceId) base.internal_resource_id = query.internalResourceId;

    // Active by default; unlinked history is opt-in so the normal view isn't
    // polluted by rows that no longer correspond to anything.
    const scope = query.scope ?? 'active';
    if (scope === 'active') base.unlinked_at = IsNull();
    if (scope === 'unlinked') base.unlinked_at = Not(IsNull());

    // Free-text search covers both directions. `external_id` is text, so it gets
    // a partial ILIKE; `internal_resource_id` is a UUID column, which Postgres
    // cannot ILIKE at all — an exact match is the only valid (and only useful)
    // comparison there, so a well-formed uuid is matched exactly and anything
    // else searches the external side only.
    const where: FindOptionsWhere<IntegrationIdMap>[] = query.search
      ? [
          { ...base, external_id: ILike(`%${query.search}%`) },
          ...(UUID_RE.test(query.search.trim())
            ? [{ ...base, internal_resource_id: query.search.trim() }]
            : []),
        ]
      : [base];

    const [rows, total] = await this.repo.findAndCount({
      where,
      relations: { connection: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: rows.map((m) => this.toView(m)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * SOFT-unlink a mapping. The row is kept (history + reconnect reuse) and both
   * unique constraints are partial on `unlinked_at IS NULL`, so the external id
   * and the internal record immediately become mappable again without ever
   * destroying the record of what they used to point at.
   *
   * Deliberately does NOT touch the internal record: unlinking says "this
   * external system no longer tracks this record", never "delete the patient".
   */
  async unlink(
    tenantId: string,
    id: string,
    reason: UnlinkReason = UNLINK_REASON.MANUAL,
  ): Promise<IntegrationIdMap> {
    const m = await this.getOrThrow(tenantId, id);
    if (m.unlinked_at) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'This mapping is already unlinked' });
    }
    m.unlinked_at = new Date();
    m.unlink_reason = reason;
    return this.repo.save(m);
  }

  /**
   * Re-activate an unlinked mapping, or point it at a different internal record.
   *
   * Re-checks BOTH sides at relink time, because the world moved on while the
   * mapping was inactive: the external id may have been re-mapped to something
   * else, and the internal record may now be claimed by a different external id.
   * Either case is a genuine conflict and is refused rather than silently
   * producing two live mappings for the same thing.
   */
  async relink(
    tenantId: string,
    id: string,
    internalId?: string,
  ): Promise<IntegrationIdMap> {
    const m = await this.getOrThrow(tenantId, id);
    const connectionId = m.connection?.id;
    if (!connectionId) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This mapping has no connection and cannot be relinked',
      });
    }
    const resource = m.resource_type as IntegrationResource;
    const target = internalId ?? m.internal_resource_id;

    const liveExternal = await this.findByExternalId(tenantId, connectionId, resource, m.external_id);
    if (liveExternal && liveExternal.id !== m.id) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This external id is already mapped to another record — unlink that mapping first',
      });
    }
    const liveInternal = await this.findByInternalId(tenantId, connectionId, resource, target);
    if (liveInternal && liveInternal.id !== m.id) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'That internal record is already mapped to a different external id for this connection',
      });
    }

    // Changing the target supersedes the historical correspondence rather than
    // rewriting it — the previous pairing stays visible as an unlinked row.
    if (target !== m.internal_resource_id) {
      if (!m.unlinked_at) {
        await this.repo.save(
          this.repo.create({
            ...m,
            id: undefined as never,
            unlinked_at: new Date(),
            unlink_reason: UNLINK_REASON.SUPERSEDED,
          }),
        );
      }
      m.internal_resource_id = target;
    }

    m.unlinked_at = null;
    m.unlink_reason = null;
    try {
      return await this.repo.save(m);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a relink race against a concurrent mapping creation.
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'Another mapping for this record was created while relinking — refresh and try again',
        });
      }
      throw err;
    }
  }

  /**
   * RECONNECT: carry a disconnected connection's mappings over to a replacement
   * connection so the tenant does not have to re-import and risk duplicate
   * records. History is preserved on BOTH sides — the source rows are soft
   * unlinked with `connection_replaced`, and each new row records the connection
   * it came from.
   *
   * Reconnecting to the SAME connection is a no-op by definition (its mappings
   * are already there), which is why an ordinary deactivate → activate needs no
   * mapping work at all.
   */
  async transferMappings(
    tenantId: string,
    fromConnectionId: string,
    toConnectionId: string,
  ): Promise<{ transferred: number; skipped: number }> {
    if (fromConnectionId === toConnectionId) return { transferred: 0, skipped: 0 };

    const rows = await this.repo.find({
      where: {
        tenant: { id: tenantId },
        connection: { id: fromConnectionId },
        unlinked_at: IsNull(),
      },
      relations: { connection: true },
    });

    let transferred = 0;
    let skipped = 0;
    for (const row of rows) {
      const resource = row.resource_type as IntegrationResource;
      // Never clobber a mapping the target connection already has.
      const clashExternal = await this.findByExternalId(tenantId, toConnectionId, resource, row.external_id);
      const clashInternal = await this.findByInternalId(tenantId, toConnectionId, resource, row.internal_resource_id);
      if (clashExternal || clashInternal) {
        skipped += 1;
        continue;
      }
      try {
        await this.repo.save(
          this.repo.create({
            tenant: { id: tenantId } as Tenant,
            connection: { id: toConnectionId } as IntegrationConnection,
            resource_type: row.resource_type,
            external_id: row.external_id,
            internal_resource_id: row.internal_resource_id,
            source: row.source,
            replaced_connection_id: fromConnectionId,
          }),
        );
        row.unlinked_at = new Date();
        row.unlink_reason = UNLINK_REASON.CONNECTION_REPLACED;
        await this.repo.save(row);
        transferred += 1;
      } catch (err) {
        if (isUniqueViolation(err)) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    return { transferred, skipped };
  }

  /** How much history a destructive action would remove — shown before confirming. */
  async retentionImpact(tenantId: string, connectionId: string) {
    const [active, unlinked] = await Promise.all([
      this.repo.count({ where: { tenant: { id: tenantId }, connection: { id: connectionId }, unlinked_at: IsNull() } }),
      this.repo.count({ where: { tenant: { id: tenantId }, connection: { id: connectionId }, unlinked_at: Not(IsNull()) } }),
    ]);
    return { activeMappings: active, unlinkedMappings: unlinked };
  }

  async getOrThrow(tenantId: string, id: string): Promise<IntegrationIdMap> {
    const m = await this.repo.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { connection: true },
    });
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Mapping not found' });
    return m;
  }

  /** Hard-delete every mapping for a connection. Privileged + audited by the caller. */
  async purgeForConnection(tenantId: string, connectionId: string): Promise<number> {
    const res = await this.repo
      .createQueryBuilder()
      .delete()
      .from(IntegrationIdMap)
      .where('"tenantId" = :tenantId', { tenantId })
      .andWhere('"connectionId" = :connectionId', { connectionId })
      .execute();
    return res.affected ?? 0;
  }

  /** Safe projection — ids only, never any record content. */
  private toView(m: IntegrationIdMap) {
    return {
      id: m.id,
      connectionId: m.connection?.id ?? null,
      resourceType: m.resource_type,
      externalId: m.external_id,
      internalResourceId: m.internal_resource_id,
      source: m.source,
      /** false = historical row kept for audit/reconnect, not a live mapping. */
      active: !m.unlinked_at,
      unlinkedAt: m.unlinked_at ?? null,
      unlinkReason: m.unlink_reason ?? null,
      replacedConnectionId: m.replaced_connection_id ?? null,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    };
  }
}

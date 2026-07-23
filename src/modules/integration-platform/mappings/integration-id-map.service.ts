import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { IntegrationIdMap } from '../../../entities/Integration/IntegrationIdMap';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';

import {
  IntegrationResource,
  MAPPING_SOURCE,
  MappingSource,
} from '../integration-platform.constants';
import { QueryMappingsDto } from '../dto/query-mappings.dto';

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

  /** Look up the internal id an external id currently maps to (or null). */
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
      },
    });
  }

  /** Look up the external id a given internal record is already mapped to (or null). */
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
      },
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
    const where: FindOptionsWhere<IntegrationIdMap> = { tenant: { id: tenantId } };
    if (query.connectionId) where.connection = { id: query.connectionId };
    if (query.resourceType) where.resource_type = query.resourceType;
    if (query.externalId) where.external_id = query.externalId;

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

  /** Safe projection — ids only, never any record content. */
  private toView(m: IntegrationIdMap) {
    return {
      id: m.id,
      connectionId: m.connection?.id ?? null,
      resourceType: m.resource_type,
      externalId: m.external_id,
      internalResourceId: m.internal_resource_id,
      source: m.source,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    };
  }
}

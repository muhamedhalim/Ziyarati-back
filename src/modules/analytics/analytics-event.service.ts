import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { AnalyticsEvent } from '../../entities/Analytics/AnalyticsEvent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { TrackEventDto } from './dto/track-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';

/**
 * Event ingestion layer (`analytics_events`).
 *
 * Tenant-scoped via the `tenant` relation; the tenant always comes from
 * TenantContext. `branchId`, when provided, is validated to belong to the tenant
 * (no cross-tenant reference). Listing is filtered + paginated and indexed-query
 * friendly (tenant + created_at ordering).
 */
@Injectable()
export class AnalyticsEventService {
  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly events: Repository<AnalyticsEvent>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
  ) {}

  async track(tenantId: string, dto: TrackEventDto): Promise<AnalyticsEvent> {
    if (dto.branchId) {
      const branch = await this.branches.findOne({
        where: { id: dto.branchId, tenant: { id: tenantId } },
      });
      if (!branch) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
      }
    }

    return this.events.save(
      this.events.create({
        tenant: { id: tenantId } as Tenant,
        branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
        event_type: dto.event_type,
        entity_type: dto.entity_type,
        entity_id: dto.entity_id,
        metadata: dto.metadata,
      }),
    );
  }

  async list(tenantId: string, query: QueryEventsDto) {
    const where: FindOptionsWhere<AnalyticsEvent> = { tenant: { id: tenantId } };
    if (query.eventType) where.event_type = query.eventType;
    if (query.entityType) where.entity_type = query.entityType;
    if (query.branchId) where.branch = { id: query.branchId };
    if (query.from && query.to) {
      where.created_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.created_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.created_at = LessThan(new Date(query.to));
    }

    const [data, total] = await this.events.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AnalyticsEvent } from '../../entities/Analytics/AnalyticsEvent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { TrackEventDto } from './dto/track-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';
import { AnalyticsQueryBuilder } from './query/analytics-query.builder';
import { Page } from './query/report-query.builder';

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

  list(tenantId: string, query: QueryEventsDto): Promise<Page<AnalyticsEvent>> {
    let qb = AnalyticsQueryBuilder.scoped(
      this.events.createQueryBuilder('event'),
      'event',
      tenantId,
    );
    qb = AnalyticsQueryBuilder.filters(qb, 'event', query);
    return AnalyticsQueryBuilder.page(qb, 'event', query);
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  ILike,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { ApiLog } from '../../entities/System/ApiLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { QueryApiLogsDto } from './dto/query-api-logs.dto';

export interface ApiLogInput {
  endpoint?: string;
  method?: string;
  statusCode?: number;
  responseTimeMs?: number;
  ipAddress?: string;
  /** The API key that authenticated this request, if any. */
  apiKeyId?: string | null;
}

/**
 * API request audit log (`api_logs`) — observability for external integrations.
 *
 * Tenant-scoped via the `tenant` relation. Read-only to clients; `record()` is
 * the ingestion seam for a future logging interceptor/middleware (no public
 * write route). Schema note: there is no api_key/user column, so consumption is
 * reported by endpoint/method/status only.
 */
@Injectable()
export class ApiLogService {
  constructor(
    @InjectRepository(ApiLog)
    private readonly logs: Repository<ApiLog>,
  ) {}

  /**
   * Ingestion seam (ApiLoggingInterceptor). Tenant optional (platform requests).
   *
   * `insert()`, not `save()`. `save()` routes through the persistence executor,
   * which wraps even a single new row in its own transaction — measured as
   * BEGIN + INSERT + COMMIT, i.e. THREE statements and a pooled connection held
   * across a transaction, for every logged request (~8,900 extra statements per
   * 2,958-request baseline). `insert()` emits one statement and takes no
   * transaction. Nothing is lost: this row is append-only, has no lifecycle
   * hooks or subscribers, and the caller discards the return value.
   */
  async record(tenantId: string | null, input: ApiLogInput): Promise<void> {
    await this.logs.insert({
      tenant: tenantId ? ({ id: tenantId } as Tenant) : undefined,
      endpoint: input.endpoint,
      method: input.method,
      status_code: input.statusCode,
      response_time_ms: input.responseTimeMs,
      ip_address: input.ipAddress,
      api_key_id: input.apiKeyId ?? undefined,
    });
  }

  async list(tenantId: string, query: QueryApiLogsDto) {
    const where: FindOptionsWhere<ApiLog> = { tenant: { id: tenantId } };
    if (query.endpoint) where.endpoint = ILike(`%${query.endpoint}%`);
    if (query.method) where.method = query.method.toUpperCase();
    if (query.statusCode !== undefined) where.status_code = query.statusCode;
    if (query.from && query.to) {
      where.created_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.created_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.created_at = LessThan(new Date(query.to));
    }

    // Keyset path: no COUNT, O(limit) — required at millions of rows.
    if (query.cursor) {
      where.created_at = LessThan(new Date(query.cursor));
      const rows = await this.logs.find({
        where,
        order: { created_at: 'DESC' },
        take: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      const data = hasMore ? rows.slice(0, query.limit) : rows;
      const nextCursor = hasMore ? data[data.length - 1].created_at.toISOString() : null;
      return { data, nextCursor, hasMore, limit: query.limit };
    }

    const [data, total] = await this.logs.findAndCount({
      where,
      order: { created_at: query.sort === 'asc' ? 'ASC' : 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  async get(tenantId: string, id: string): Promise<ApiLog> {
    const log = await this.logs.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!log) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'API log not found' });
    }
    return log;
  }

  /** Usage statistics + consumption metrics (tenant-scoped aggregates). */
  async stats(tenantId: string) {
    const base = this.logs
      .createQueryBuilder('l')
      .innerJoin('l.tenant', 't')
      .where('t.id = :tenantId', { tenantId });

    const totals = await base
      .clone()
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(l.response_time_ms), 0)', 'avgResponseMs')
      .addSelect('COUNT(*) FILTER (WHERE l.status_code >= 400)', 'errors')
      .getRawOne<{ total: string; avgResponseMs: string; errors: string }>();

    const byMethod = await base
      .clone()
      .select('l.method', 'method')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.method')
      .orderBy('count', 'DESC')
      .getRawMany<{ method: string; count: string }>();

    const byStatus = await base
      .clone()
      .select('l.status_code', 'statusCode')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.status_code')
      .orderBy('count', 'DESC')
      .getRawMany<{ statusCode: number; count: string }>();

    const total = Number(totals?.total ?? 0);
    const errors = Number(totals?.errors ?? 0);
    return {
      totalRequests: total,
      avgResponseMs: Math.round(Number(totals?.avgResponseMs ?? 0)),
      errors,
      errorRate: total > 0 ? +(errors / total).toFixed(4) : 0,
      byMethod: byMethod.map((r) => ({ method: r.method, count: Number(r.count) })),
      byStatus: byStatus.map((r) => ({
        statusCode: r.statusCode,
        count: Number(r.count),
      })),
    };
  }
}

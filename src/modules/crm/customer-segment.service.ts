import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { CustomerSegment } from '../../entities/CRM/CustomerSegment';
import { AppError, ErrorCode } from '../../common/errors';

import { SegmentQueryBuilder } from './segment-query.builder';
import {
  SegmentMatch,
  SegmentRule,
  SEGMENT_PREVIEW_SAMPLE_SIZE,
  SEGMENT_RESOLVE_PAGE_SIZE,
} from './segment.constants';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';

export interface SegmentPreview {
  count: number;
  sample: {
    id: string;
    fullName: string | null;
    lastAppointmentAt: string | null;
  }[];
  consentEligibleCount: number;
  evaluatedAt: string;
}

export interface SegmentResolvePage {
  customerIds: string[];
  nextCursor: string | null;
}

/**
 * Spec 014 (Clinic Platform Completion) — Phase 10 (US8, T122).
 *
 * CRUD over `CustomerSegment` + two read paths that never share code with
 * each other's guarantees:
 *  - `preview` is a plain COUNT/sample — side-effect-free, dispatches
 *    nothing, and its `evaluatedAt` timestamp makes the point-in-time nature
 *    explicit (FR-S006) — a saved segment's actual membership can drift the
 *    moment after this call returns.
 *  - `resolve` is KEYSET-paginated over `customers.id` so a large audience
 *    (SC-023, 100k+) is never materialised whole in memory; used by
 *    `CampaignFanoutService`, never by the API surface directly.
 *
 * Consent filtering (FR-S008) is applied AFTER rule resolution, as a
 * separate count/condition — never folded into the rule vocabulary itself,
 * so a saved segment's definition never silently encodes today's opt-out
 * list.
 */
@Injectable()
export class CustomerSegmentService {
  constructor(
    @InjectRepository(CustomerSegment)
    private readonly segments: Repository<CustomerSegment>,
    private readonly dataSource: DataSource,
    private readonly queryBuilder: SegmentQueryBuilder,
  ) {}

  async create(
    tenantId: string,
    userId: string,
    dto: CreateSegmentDto,
  ): Promise<CustomerSegment> {
    this.validateRules(tenantId, dto.rules, dto.match);
    const segment = this.segments.create({
      tenant: { id: tenantId } as never,
      name: dto.name,
      description: dto.description,
      rules: dto.rules,
      match: dto.match,
      created_by: { id: userId } as never,
    });
    return this.segments.save(segment);
  }

  async list(tenantId: string): Promise<CustomerSegment[]> {
    return this.segments.find({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
  }

  async findOne(tenantId: string, id: string): Promise<CustomerSegment> {
    const segment = await this.segments.findOne({
      where: { id, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!segment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Segment not found' });
    }
    return segment;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateSegmentDto,
  ): Promise<CustomerSegment> {
    const segment = await this.findOne(tenantId, id);
    if (dto.rules !== undefined || dto.match !== undefined) {
      this.validateRules(
        tenantId,
        dto.rules ?? segment.rules,
        dto.match ?? segment.match,
      );
    }
    if (dto.name !== undefined) segment.name = dto.name;
    if (dto.description !== undefined) segment.description = dto.description;
    if (dto.rules !== undefined) segment.rules = dto.rules;
    if (dto.match !== undefined) segment.match = dto.match;
    return this.segments.save(segment);
  }

  /**
   * Soft-delete only. A campaign already referencing this segment keeps
   * `segment_id` pointing at a (now hidden) row — that campaign's own past
   * runs are untouched (FR-S011); only NEW resolution is affected. A
   * completed run's recipient rows were already materialised at fan-out
   * time and are never re-derived from a segment afterward — this service
   * has no reference to that table at all.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    const segment = await this.findOne(tenantId, id);
    segment.deleted_at = new Date();
    await this.segments.save(segment);
  }

  /** Side-effect-free. Never persists, never dispatches. */
  async preview(
    tenantId: string,
    rules: SegmentRule[],
    match: SegmentMatch,
  ): Promise<SegmentPreview> {
    this.validateRules(tenantId, rules, match);
    const { whereSql, values } = this.queryBuilder.build(
      tenantId,
      rules,
      match,
    );

    const [{ c: count }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM customers c WHERE ${whereSql}`,
      values,
    );
    const [{ c: consentEligibleCount }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM customers c
       WHERE ${whereSql} AND c.marketing_opt_in = true AND c.opted_out_at IS NULL`,
      values,
    );
    const sample = await this.dataSource.query(
      `SELECT c.id AS id, c.full_name AS "fullName",
         (SELECT MAX(a.start_at) FROM appointments a WHERE a."customerId" = c.id) AS "lastAppointmentAt"
       FROM customers c WHERE ${whereSql}
       ORDER BY c.id ASC LIMIT ${SEGMENT_PREVIEW_SAMPLE_SIZE}`,
      values,
    );

    return {
      count,
      consentEligibleCount,
      sample,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Keyset page of matching customer ids for a SAVED segment, tenant-scoped.
   * Re-runs the rules against LIVE data every call — never caches membership
   * — so a newly-qualifying customer is picked up and a no-longer-qualifying
   * one drops out between pages (FR-S007).
   */
  async resolve(
    tenantId: string,
    segmentId: string,
    cursor: string | null,
    limit: number = SEGMENT_RESOLVE_PAGE_SIZE,
  ): Promise<SegmentResolvePage> {
    const segment = await this.findOne(tenantId, segmentId);
    const { whereSql, values } = this.queryBuilder.build(
      tenantId,
      segment.rules,
      segment.match,
    );

    const cursorClause = cursor ? `AND c.id > $${values.length + 1}` : '';
    const params = cursor ? [...values, cursor] : values;

    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT c.id AS id FROM customers c WHERE ${whereSql} ${cursorClause}
       ORDER BY c.id ASC LIMIT ${limit}`,
      params,
    );

    return {
      customerIds: rows.map((r) => r.id),
      nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  private validateRules(
    tenantId: string,
    rules: SegmentRule[],
    match: SegmentMatch,
  ): void {
    // Compiling (without executing) is the validation — SegmentQueryBuilder
    // throws BAD_REQUEST on an unknown field/operator before any query runs.
    this.queryBuilder.build(tenantId, rules, match);
  }
}

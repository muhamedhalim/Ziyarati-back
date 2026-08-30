import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClinicalEntry } from '../../entities/Clinical/ClinicalEntry';
import { ClinicalEntryKind } from '../../entities/enums';
import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { User } from '../../entities/Auth&RBAC/User';

export interface TimelineItem {
  type: 'ENCOUNTER' | 'ENTRY' | 'FILE';
  id: string;
  kind: ClinicalEntryKind | null;
  occurredAt: Date;
  recordedAt: Date;
  author: { id: string; name: string | null } | null;
  data: Record<string, unknown>;
  fromCancelledVisit: boolean;
}

export interface TimelinePage {
  data: TimelineItem[];
  total: number;
  page: number;
  limit: number;
  /** FR-H007 — present on every clinical read, not only when scrolled to. */
  allergies: Record<string, unknown>[];
}

interface RawTimelineRow {
  type: 'ENCOUNTER' | 'ENTRY' | 'FILE';
  id: string;
  kind: string | null;
  occurred_at: Date;
  recorded_at: Date;
  author_id: string | null;
  data: Record<string, unknown>;
  from_cancelled_visit: boolean;
}

/**
 * Spec 014 (Clinic Platform Completion) — T111/T113 (US6, FR-H006, FR-H007).
 *
 * Unites encounters, clinical entries and existing `CustomerFile` rows in a
 * SINGLE paginated query (a raw `UNION ALL` — the three source shapes are
 * heterogeneous enough that TypeORM's query builder can't express one join
 * across them), ordered `(tenant, customer, recorded_at DESC)`. Author names
 * are then resolved in ONE additional batched query over the page's DISTINCT
 * author ids — never one query per row (no N+1 across authors). Total query
 * count is therefore FIXED at 4 (data + count + authors + allergies)
 * regardless of page size. Entries whose encounter's appointment was
 * cancelled are marked `fromCancelledVisit`, never excluded (FR-H005).
 * Active allergies (FR-H007) ride along on the SAME response — present on
 * every clinical read, never only when scrolled to.
 */
@Injectable()
export class ClinicalTimelineService {
  constructor(
    @InjectRepository(ClinicalEntry)
    private readonly entries: Repository<ClinicalEntry>,
    @InjectRepository(CustomerProfile)
    private readonly profiles: Repository<CustomerProfile>,
    private readonly dataSource: DataSource,
  ) {}

  async getTimeline(
    tenantId: string,
    customerId: string,
    page: number,
    limit: number,
  ): Promise<TimelinePage> {
    const offset = (page - 1) * limit;

    const rows: RawTimelineRow[] = await this.dataSource.query(
      `
      SELECT * FROM (
        SELECT
          'ENCOUNTER' AS type, ce.id AS id, NULL::text AS kind,
          ce.occurred_at AS occurred_at, ce.occurred_at AS recorded_at,
          ce."authorId" AS author_id,
          jsonb_build_object('summary', ce.summary) AS data,
          (a.status = 'CANCELLED') AS from_cancelled_visit
        FROM clinical_encounters ce
        LEFT JOIN appointments a ON a.id = ce."appointmentId"
        WHERE ce."tenantId" = $1 AND ce."customerId" = $2

        UNION ALL

        SELECT
          'ENTRY' AS type, cen.id AS id, cen.kind::text AS kind,
          cen.recorded_at AS occurred_at, cen.recorded_at AS recorded_at,
          cen."authorId" AS author_id, cen.data AS data,
          COALESCE(a.status = 'CANCELLED', false) AS from_cancelled_visit
        FROM clinical_entries cen
        LEFT JOIN clinical_encounters ce2 ON ce2.id = cen."encounterId"
        LEFT JOIN appointments a ON a.id = ce2."appointmentId"
        WHERE cen."tenantId" = $1 AND cen."customerId" = $2 AND cen.deleted_at IS NULL

        UNION ALL

        SELECT
          'FILE' AS type, cf.id AS id, NULL::text AS kind,
          cf.created_at AS occurred_at, cf.created_at AS recorded_at,
          cf."uploadedById" AS author_id,
          jsonb_build_object('file_name', cf.file_name, 'file_type', cf.file_type) AS data,
          false AS from_cancelled_visit
        FROM customer_files cf
        WHERE cf."tenantId" = $1 AND cf."customerId" = $2
      ) timeline
      ORDER BY recorded_at DESC
      LIMIT $3 OFFSET $4
      `,
      [tenantId, customerId, limit, offset],
    );

    const [{ c: total }] = await this.dataSource.query(
      `
      SELECT (
        (SELECT COUNT(*) FROM clinical_encounters WHERE "tenantId" = $1 AND "customerId" = $2) +
        (SELECT COUNT(*) FROM clinical_entries WHERE "tenantId" = $1 AND "customerId" = $2 AND deleted_at IS NULL) +
        (SELECT COUNT(*) FROM customer_files WHERE "tenantId" = $1 AND "customerId" = $2)
      )::int AS c
      `,
      [tenantId, customerId],
    );

    const authorIds = [
      ...new Set(rows.map((r) => r.author_id).filter(Boolean)),
    ] as string[];
    const authors = authorIds.length
      ? await this.dataSource.getRepository(User).find({
          where: { id: In(authorIds) },
        })
      : [];
    const authorById = new Map(authors.map((a) => [a.id, a.full_name ?? null]));
    const allergies = await this.getActiveAllergies(tenantId, customerId);

    return {
      allergies,
      data: rows.map((r) => ({
        type: r.type,
        id: r.id,
        kind: (r.kind as ClinicalEntryKind | null) ?? null,
        occurredAt: r.occurred_at,
        recordedAt: r.recorded_at,
        author: r.author_id
          ? { id: r.author_id, name: authorById.get(r.author_id) ?? null }
          : null,
        data: r.data,
        fromCancelledVisit: r.from_cancelled_visit,
      })),
      total: Number(total),
      page,
      limit,
    };
  }

  /**
   * FR-H007 — allergies as a distinct block, present on every clinical read
   * (timeline, summary, single-entry), never only when scrolled to.
   */
  async getActiveAllergies(
    tenantId: string,
    customerId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.entries.find({
      where: {
        tenant: { id: tenantId },
        customer: { id: customerId },
        kind: ClinicalEntryKind.ALLERGY,
      },
      order: { recorded_at: 'DESC' },
    });
    return rows.map((r) => r.data);
  }

  /**
   * Patient-level summary: allergies (FR-H007) + the legacy free-text
   * profile content (FR-H004 — preserved, never migrated away).
   */
  async getSummary(
    tenantId: string,
    customerId: string,
  ): Promise<{
    allergies: Record<string, unknown>[];
    legacyProfile: { medical_history?: string; notes?: string } | null;
  }> {
    const [allergies, profile] = await Promise.all([
      this.getActiveAllergies(tenantId, customerId),
      this.profiles.findOne({
        where: { tenant: { id: tenantId }, customer: { id: customerId } },
      }),
    ]);
    return {
      allergies,
      legacyProfile: profile
        ? { medical_history: profile.medical_history, notes: profile.notes }
        : null,
    };
  }
}

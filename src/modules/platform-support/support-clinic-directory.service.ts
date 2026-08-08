import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { QuerySupportClinicsDto } from './dto/query-support-clinics.dto';
import { isoOrNull } from './support-privacy.util';

/**
 * ============================================================================
 *  SUPPORT OPERATIONS CONSOLE — clinic directory
 * ============================================================================
 *
 * The proactive entry point. Every other diagnostic in this module answers
 * "what is wrong with clinic X"; this one answers "which clinic is X" — the
 * step that has to happen first when a clinic phones support, emails a shared
 * inbox, or is investigated before anyone has filed a ticket.
 *
 * WHY THIS IS NOT `GET /tenants`. The Super Admin tenant directory returns the
 * administrative view of a tenant: verification documents and their review
 * state, commercial registration and legal identity, approval workflow
 * controls, and the mutation routes (approve / reject / suspend) that live
 * beside it. Support needs none of that and must not receive it. This endpoint
 * therefore builds its own projection from named columns and stays strictly
 * read-only — Platform Support holds no slug that can change a clinic's
 * approval state, activity or plan.
 *
 * WHY THE SHAPE OF THE QUERY MATTERS. A directory row wants aggregates
 * (branch count, open tickets, last support activity) that are the classic
 * source of an N+1: fetch a page of clinics, then loop. The statement below
 * avoids that structurally — the page of tenants is selected, ordered and
 * limited in a CTE FIRST, and the aggregates are lateral-joined onto that
 * already-bounded set. The number of aggregate evaluations equals the page
 * size, never the tenant count, and adding a column here can never turn into a
 * per-row round trip.
 *
 * Subscription plan is included because it comes free from the same statement
 * (one lateral for the current subscription row, one plain join for its plan
 * name). It is the plan IDENTITY only — never price, never internal cost,
 * never the plan catalogue. Anything beyond "which plan" belongs to the
 * subscription-diagnostics endpoint, which is separately permissioned.
 */
@Injectable()
export class SupportClinicDirectoryService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: QuerySupportClinicsDto) {
    const params: unknown[] = [];
    const filters: string[] = ['t.deleted_at IS NULL'];

    const search = query.search?.trim();
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      // Contact email and phone are searchable because that is how a caller
      // identifies themselves. They are CLINIC contact details — the business
      // Support is corresponding with — not a patient's, and they already
      // appear on the ticket-detail response for the same reason.
      filters.push(
        `(t.name ILIKE ${p} OR t.slug ILIKE ${p} OR t.contact_email ILIKE ${p} OR t.contact_phone ILIKE ${p})`,
      );
    }
    if (query.approvalStatus) {
      params.push(query.approvalStatus);
      filters.push(`t.approval_status = $${params.length}`);
    }
    if (query.isActive !== undefined) {
      params.push(query.isActive === 'true');
      filters.push(`t.is_active = $${params.length}`);
    }

    const where = filters.join(' AND ');

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM tenants t WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        WITH page AS (
          SELECT t.id, t.name, t.slug, t.contact_email, t.contact_phone,
                 t.is_active, t.approval_status, t.created_at
            FROM tenants t
           WHERE ${where}
           ORDER BY t.name ASC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        )
        SELECT p.*,
               sub.status  AS subscription_status,
               pl.name     AS plan_name,
               br.total    AS branches_total,
               br.active   AS branches_active,
               tk.open_tickets,
               tk.total_tickets,
               tk.last_ticket_activity_at
          FROM page p
          LEFT JOIN LATERAL (
            SELECT s.status, s."planId"
              FROM subscriptions s
             WHERE s."tenantId" = p.id AND s.deleted_at IS NULL
             ORDER BY s.created_at DESC
             LIMIT 1
          ) sub ON true
          LEFT JOIN subscription_plans pl ON pl.id = sub."planId"
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE b.is_active)::int AS active
              FROM branches b
             WHERE b."tenantId" = p.id AND b.deleted_at IS NULL
          ) br ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*) FILTER (
                     WHERE st.status NOT IN ('resolved', 'closed')
                   )::int AS open_tickets,
                   COUNT(*)::int AS total_tickets,
                   MAX(st.updated_at) AS last_ticket_activity_at
              FROM support_tickets st
             WHERE st."tenantId" = p.id
          ) tk ON true
         ORDER BY p.name ASC
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    return {
      data: rows.map((r: ClinicDirectoryRow) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        contactEmail: r.contact_email ?? null,
        contactPhone: r.contact_phone ?? null,
        isActive: r.is_active,
        approvalStatus: r.approval_status,
        createdAt: isoOrNull(r.created_at),
        // Plan IDENTITY only. Price, billing cycle, internal cost and the plan
        // catalogue are Super Admin surface and are not selected above.
        subscriptionStatus: r.subscription_status ?? null,
        planName: r.plan_name ?? null,
        branchesTotal: r.branches_total ?? 0,
        branchesActive: r.branches_active ?? 0,
        openTicketCount: r.open_tickets ?? 0,
        totalTicketCount: r.total_tickets ?? 0,
        lastTicketActivityAt: isoOrNull(r.last_ticket_activity_at),
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }
}

interface ClinicDirectoryRow {
  id: string;
  name: string;
  slug: string;
  contact_email: string | null;
  contact_phone: string | null;
  is_active: boolean;
  approval_status: string;
  created_at: Date | string | null;
  subscription_status: string | null;
  plan_name: string | null;
  branches_total: number | null;
  branches_active: number | null;
  open_tickets: number | null;
  total_tickets: number | null;
  last_ticket_activity_at: Date | string | null;
}

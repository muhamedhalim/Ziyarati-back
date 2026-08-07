import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { AvailabilityService } from '../scheduling/availability.service';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * The eligibility predicate every public query shares: an APPROVED, active,
 * non-deleted clinic that has explicitly opted in to public booking.
 *
 * `COALESCE(ts.public_booking_enabled, false)` makes a MISSING settings row mean
 * "not opted in" rather than "unset, therefore allowed" — the same fail-closed
 * posture the rest of this feature uses. Requires the caller to alias `tenants`
 * as `t` and LEFT JOIN `tenant_settings` as `ts`.
 */
const ELIGIBLE_CLINIC = `t.approval_status = 'APPROVED'
   AND t.is_active = true
   AND t.deleted_at IS NULL
   AND COALESCE(ts.public_booking_enabled, false) = true`;

/**
 * "Explicit configuration wins" — the branch-scoped service rule (D1).
 *
 * `service_prices (serviceId, branchId, price, is_active)` already existed with
 * `UNIQUE(serviceId, branchId)`; nothing read it. Now:
 *
 *  - a service with AT LEAST ONE active `service_prices` row is offered ONLY at
 *    the branches that have one, at that row's price; and
 *  - a service with NO rows at all is unconfigured legacy data — offered
 *    everywhere at `services.base_price`.
 *
 * So a clinic that never touches branch pricing keeps working exactly as before,
 * while a clinic that does configure it gets real per-branch restriction and
 * per-branch pricing. Requires `sp` to be the LEFT JOIN for THIS branch.
 */
const BRANCH_OFFERS_SERVICE = `(
     sp.id IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM service_prices sp2
        WHERE sp2."serviceId" = s.id AND sp2.is_active = true
     )
   )`;

/**
 * Public (anonymous) clinic discovery for the website chat widget.
 *
 * READ-ONLY, cross-tenant, and STRICTLY limited to public marketing fields of
 * APPROVED + active + opted-in clinics (name/slug/logo, branch name/city/address,
 * service names/prices, doctor titles). It never exposes private tenant data
 * (patients, finance, settings, contacts) and never mutates anything — so it is
 * safe to serve unauthenticated.
 *
 * SOFT DELETES: every query here is raw SQL, so TypeORM's automatic
 * `deleted_at IS NULL` filter does NOT apply. Each one therefore spells the
 * predicate out. Missing it previously published soft-deleted branches,
 * discontinued services at stale prices, and departed staff members' real names
 * to anonymous callers.
 */
@Injectable()
export class PublicDiscoveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly availability: AvailabilityService,
  ) {}

  /**
   * Cities that actually have something bookable in them — the first step of
   * the booking flow. Derived from live branches rather than the full `cities`
   * lookup, so the visitor is never offered a city with no clinics.
   */
  async listCities(): Promise<
    { id: string; nameAr: string | null; nameEn: string | null }[]
  > {
    const rows = await this.dataSource.query(
      `SELECT DISTINCT c.id, c.name_ar, c.name_en
         FROM cities c
         JOIN branches b ON b.city_id = c.id AND b.is_active = true AND b.deleted_at IS NULL
         JOIN tenants t ON t.id = b."tenantId"
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE ${ELIGIBLE_CLINIC}
        ORDER BY c.name_en NULLS LAST
        LIMIT 200`,
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      nameAr: (r.name_ar as string) ?? null,
      nameEn: (r.name_en as string) ?? null,
    }));
  }

  /**
   * Search public clinics by name/slug or an offered service (e.g. "dentist"),
   * optionally narrowed to a city.
   */
  async searchClinics(query: string | undefined, limit = 12, cityId?: string) {
    const like = query?.trim() ? `%${query.trim()}%` : null;
    const city = cityId?.trim() || null;

    const rows = await this.dataSource.query(
      `SELECT t.id, t.name, t.slug, t.logo_url,
              (SELECT COUNT(*)::int FROM branches b
                WHERE b."tenantId" = t.id AND b.is_active = true AND b.deleted_at IS NULL) AS branches,
              (SELECT string_agg(x.name, ', ') FROM (
                 SELECT name FROM services
                  WHERE "tenantId" = t.id AND is_active = true AND deleted_at IS NULL
                  ORDER BY name LIMIT 4
               ) x) AS services
         FROM tenants t
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE ${ELIGIBLE_CLINIC}
          AND ($1::text IS NULL
               OR t.name ILIKE $1 OR t.slug ILIKE $1
               OR EXISTS (SELECT 1 FROM services sv
                           WHERE sv."tenantId" = t.id AND sv.is_active = true
                             AND sv.deleted_at IS NULL AND sv.name ILIKE $1))
          AND ($3::uuid IS NULL
               OR EXISTS (SELECT 1 FROM branches cb
                           WHERE cb."tenantId" = t.id AND cb.is_active = true
                             AND cb.deleted_at IS NULL AND cb.city_id = $3::uuid))
        ORDER BY t.name ASC
        LIMIT $2`,
      [like, Math.min(limit, 24), city],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      slug: r.slug as string,
      logoUrl: (r.logo_url as string) ?? null,
      branchCount: n(r.branches),
      services: (r.services as string) ?? null,
    }));
  }

  /**
   * Public detail for a chosen clinic: branches (WITH their location), plus the
   * clinic-level service and doctor lists used to preview what it offers.
   *
   * The clinic-level lists are a PREVIEW only — booking must use
   * `listBranchServices` / `listBranchDoctors`, which apply the branch rules.
   */
  async clinicDetail(clinicId: string) {
    const tenant = await this.dataSource.query(
      `SELECT t.id, t.name, t.slug, t.logo_url
         FROM tenants t
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE t.id = $1 AND ${ELIGIBLE_CLINIC}`,
      [clinicId],
    );
    if (!tenant[0])
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Clinic not found' });

    const [branches, services, doctors] = await Promise.all([
      // M-3: `address` and the resolved city name are now RETURNED. `city_id`
      // used to be selected and then silently dropped by the mapper, so a
      // visitor could never tell two branches apart by where they are.
      this.dataSource.query(
        `SELECT b.id, b.name, b.address, b.city_id, c.name_ar AS city_ar, c.name_en AS city_en
           FROM branches b
           LEFT JOIN cities c ON c.id = b.city_id
          WHERE b."tenantId" = $1 AND b.is_active = true AND b.deleted_at IS NULL
          ORDER BY b.name LIMIT 50`,
        [clinicId],
      ),
      this.dataSource.query(
        `SELECT id, name, base_price FROM services
          WHERE "tenantId" = $1 AND is_active = true AND deleted_at IS NULL
          ORDER BY name LIMIT 50`,
        [clinicId],
      ),
      // F-6: previously an unfiltered `staff_profiles` scan — it published
      // soft-deleted and non-bookable staff, and any non-clinical user with a
      // profile was rendered to the public as "Doctor" by the COALESCE.
      this.dataSource.query(
        `SELECT sp.id, COALESCE(u.full_name, sp.title, 'Doctor') AS name, sp.title
           FROM staff_profiles sp
           LEFT JOIN users u ON u.id = sp.user_id AND u.deleted_at IS NULL AND u.is_active = true
          WHERE sp."tenantId" = $1
            AND sp.deleted_at IS NULL
            AND sp.is_available_for_booking = true
          ORDER BY name LIMIT 50`,
        [clinicId],
      ),
    ]);

    return {
      clinic: {
        id: tenant[0].id,
        name: tenant[0].name,
        slug: tenant[0].slug,
        logoUrl: tenant[0].logo_url ?? null,
      },
      branches: branches.map((b: Record<string, unknown>) => ({
        id: b.id as string,
        name: b.name as string,
        address: (b.address as string) ?? null,
        city: b.city_id
          ? {
              id: b.city_id as string,
              nameAr: (b.city_ar as string) ?? null,
              nameEn: (b.city_en as string) ?? null,
            }
          : null,
      })),
      services: services.map((s: Record<string, unknown>) => ({
        id: s.id as string,
        name: s.name as string,
        price: s.base_price == null ? null : n(s.base_price),
      })),
      doctors: doctors.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        name: d.name as string,
        title: (d.title as string) ?? null,
      })),
    };
  }

  /**
   * Services actually offered AT a branch, at that branch's price.
   *
   * `tenantId` is the caller's already-resolved clinic (from
   * `PublicBookingContextService`), never a caller-supplied value.
   */
  async listBranchServices(tenantId: string, branchId: string) {
    const rows = await this.dataSource.query(
      `SELECT s.id, s.name, s.duration_minutes,
              COALESCE(sp.price, s.base_price) AS price,
              s.pricing_type
         FROM services s
         LEFT JOIN service_prices sp
                ON sp."serviceId" = s.id AND sp."branchId" = $2 AND sp.is_active = true
        WHERE s."tenantId" = $1
          AND s.is_active = true
          AND s.deleted_at IS NULL
          AND ${BRANCH_OFFERS_SERVICE}
        ORDER BY s.name LIMIT 50`,
      [tenantId, branchId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      durationMinutes: n(r.duration_minutes),
      price: r.price == null ? null : n(r.price),
      pricingType: r.pricing_type as string,
    }));
  }

  /**
   * Doctors who actually work AT a branch (D2): a doctor is bookable there iff
   * they hold an ACTIVE `staff_schedules` row for that branch. That table
   * already carried `branchId`; it was consulted only deep inside availability
   * computation, where it failed OPEN — so a doctor from another branch (or one
   * with no schedule at all) was bookable anywhere in the clinic.
   */
  async listBranchDoctors(tenantId: string, branchId: string) {
    const rows = await this.dataSource.query(
      `SELECT DISTINCT sp.id, COALESCE(u.full_name, sp.title, 'Doctor') AS name, sp.title
         FROM staff_profiles sp
         JOIN staff_schedules ss
           ON ss."staffId" = sp.id AND ss."branchId" = $2 AND ss.is_active = true
         LEFT JOIN users u ON u.id = sp.user_id AND u.deleted_at IS NULL AND u.is_active = true
        WHERE sp."tenantId" = $1
          AND sp.deleted_at IS NULL
          AND sp.is_available_for_booking = true
        ORDER BY name LIMIT 50`,
      [tenantId, branchId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      title: (r.title as string) ?? null,
    }));
  }

  /**
   * Public free-slot lookup for a chosen clinic's branch + doctor on a day.
   *
   * The owning tenant is resolved SERVER-SIDE from the branch, never trusted
   * from the caller. Slot computation is delegated to the existing
   * AvailabilityService (no scheduling logic is duplicated here).
   */
  async publicAvailability(
    branchId: string,
    staffId: string,
    date: string,
    slotMinutes?: number,
  ) {
    const rows = await this.dataSource.query(
      `SELECT b."tenantId" AS tenant_id
         FROM branches b
         JOIN tenants t ON t.id = b."tenantId"
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE b.id = $1 AND b.is_active = true AND b.deleted_at IS NULL
          AND ${ELIGIBLE_CLINIC}`,
      [branchId],
    );
    const tenantId: string | undefined = rows[0]?.tenant_id;
    if (!tenantId)
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });

    // N-4: `staffId` used to be forwarded completely unchecked, so the F-4
    // branch/doctor mismatch was reachable ANONYMOUSLY — a visitor could ask
    // for (branch A, doctor who only works at branch B) and get windows back.
    await this.assertDoctorAtBranch(tenantId, branchId, staffId);

    // Reuse the tenant's own availability engine with the server-resolved tenant.
    return this.availability.windows(tenantId, {
      branchId,
      staffId,
      date,
      slotMinutes,
    } as never);
  }

  /** Public-side branch/doctor pairing check. Fails closed. */
  private async assertDoctorAtBranch(
    tenantId: string,
    branchId: string,
    staffId: string,
  ): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT 1
         FROM staff_profiles sp
         JOIN staff_schedules ss
           ON ss."staffId" = sp.id AND ss."branchId" = $3 AND ss.is_active = true
        WHERE sp.id = $2
          AND sp."tenantId" = $1
          AND sp.deleted_at IS NULL
          AND sp.is_available_for_booking = true
        LIMIT 1`,
      [tenantId, staffId, branchId],
    );
    if (!rows[0]) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'This doctor is not available at the selected branch',
      });
    }
  }
}

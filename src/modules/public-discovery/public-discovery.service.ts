import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { AvailabilityService } from '../scheduling/availability.service';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** `day_of_week` is 0=Sun … 6=Sat throughout the scheduling domain. */
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Postgres `time` comes back as 'HH:MM:SS'; nobody needs the seconds. */
const hhmm = (t: string | null | undefined): string => (t ?? '').slice(0, 5);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Contract C2a — `tenants.slug` is unique and unique-indexed, and a UUID cannot
 * collide with the slug format, so a single caller-supplied identifier
 * unambiguously resolves to one lookup strategy. Checked in application code
 * (never relying on a Postgres `::uuid` cast to reject a bad value) so a
 * malformed identifier never reaches the database as a raw type error.
 */
const isUuid = (value: string): boolean => UUID_RE.test(value.trim());

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
   * `listCities()` plus the two counts that stop an empty city list from being
   * mistaken for an empty PLATFORM.
   *
   * The city taxonomy is optional data: `branches.city_id` is nullable, and a
   * clinic that never picked a city is still perfectly bookable. `listCities()`
   * INNER JOINs `cities`, so those clinics contribute no city — and a caller
   * that saw `[]` had no way to tell "nobody has opted in" from "opted-in
   * clinics exist, none of them recorded a city". The public assistant reported
   * both as "no clinics are available", which is only true of the first.
   *
   * Returning the counts alongside makes the difference explicit and lets the
   * booking flow fall back to a city-less clinic search instead of dead-ending.
   */
  async cityCoverage(): Promise<{
    cities: { id: string; nameAr: string | null; nameEn: string | null }[];
    bookableClinics: number;
    clinicsWithoutCity: number;
  }> {
    const [cities, counts] = await Promise.all([
      this.listCities(),
      this.dataSource.query(
        `SELECT
            COUNT(DISTINCT t.id)::int AS bookable,
            COUNT(DISTINCT t.id) FILTER (WHERE b.city_id IS NULL)::int AS without_city
           FROM tenants t
           LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
           JOIN branches b
             ON b."tenantId" = t.id AND b.is_active = true AND b.deleted_at IS NULL
          WHERE ${ELIGIBLE_CLINIC}`,
      ),
    ]);
    return {
      cities,
      bookableClinics: n(counts[0]?.bookable),
      clinicsWithoutCity: n(counts[0]?.without_city),
    };
  }

  /**
   * Resolves a city id to its names, or `null` when it does not exist.
   *
   * Used to VALIDATE a model-proposed `cityId` before it is recorded on the
   * session: the booking context only ever holds ids the database confirmed.
   */
  async findCity(cityId: string): Promise<{
    id: string;
    nameAr: string | null;
    nameEn: string | null;
  } | null> {
    // Fails closed on a malformed id rather than letting the `::uuid` cast
    // raise: callers treat `null` as "no such city", and a driver-level error
    // would instead surface as a tool failure.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        cityId?.trim() ?? '',
      )
    ) {
      return null;
    }
    const rows = await this.dataSource.query(
      `SELECT id, name_ar, name_en FROM cities WHERE id = $1::uuid LIMIT 1`,
      [cityId.trim()],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id as string,
          nameAr: (row.name_ar as string) ?? null,
          nameEn: (row.name_en as string) ?? null,
        }
      : null;
  }

  /**
   * Search public clinics by name/slug or an offered service (e.g. "dentist"),
   * optionally narrowed to a city.
   *
   * **AI-facing (+ legacy widget) — FROZEN signature, defaults and shape**
   * (contracts/backend-public-api.md C2 method-ownership table). The AI calls this
   * IN-PROCESS (`ai-tool-dispatch.service.ts:445`) and the shipped chat widget's
   * `useClinicSearch` depends on the bare-array, cap-24 shape. `page`/`pageSize`
   * (contract C1, BE-6) are ADDITIVE ONLY: when both are absent this returns
   * EXACTLY what it always has — a bare array, capped at 24, nothing else changed.
   * The envelope (`{items,total,page,pageSize}`) is returned ONLY when a caller
   * opts in by passing pagination params. Never change this method to satisfy a
   * Marketplace-only requirement — extend `marketplaceClinicSearch()` instead.
   */
  async searchClinics(
    query: string | undefined,
    limit = 12,
    cityId?: string,
    pagination?: { page: number; pageSize: number },
  ) {
    const like = query?.trim() ? `%${query.trim()}%` : null;
    const city = cityId?.trim() || null;
    const paginated = Boolean(pagination);
    const page = paginated ? Math.max(1, pagination!.page) : 1;
    const pageSize = paginated ? Math.min(Math.max(1, pagination!.pageSize), 24) : Math.min(limit, 24);
    const offset = (page - 1) * pageSize;

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
        LIMIT $2 OFFSET $4`,
      [like, pageSize, city, offset],
    );
    const items = rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      slug: r.slug as string,
      logoUrl: (r.logo_url as string) ?? null,
      branchCount: n(r.branches),
      services: (r.services as string) ?? null,
    }));

    if (!paginated) {
      return items;
    }

    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
         FROM tenants t
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
        WHERE ${ELIGIBLE_CLINIC}
          AND ($1::text IS NULL
               OR t.name ILIKE $1 OR t.slug ILIKE $1
               OR EXISTS (SELECT 1 FROM services sv
                           WHERE sv."tenantId" = t.id AND sv.is_active = true
                             AND sv.deleted_at IS NULL AND sv.name ILIKE $1))
          AND ($2::uuid IS NULL
               OR EXISTS (SELECT 1 FROM branches cb
                           WHERE cb."tenantId" = t.id AND cb.is_active = true
                             AND cb.deleted_at IS NULL AND cb.city_id = $2::uuid))`,
      [like, city],
    );

    return { items, total: n(total), page, pageSize };
  }

  /**
   * Public detail for a chosen clinic: branches (WITH their location), plus the
   * clinic-level service and doctor lists used to preview what it offers.
   *
   * The clinic-level lists are a PREVIEW only — booking must use
   * `listBranchServices` / `listBranchDoctors`, which apply the branch rules.
   *
   * **AI-facing (+ legacy widget) — FROZEN, including `LIMIT 50` and `base_price`**
   * (contract C2 method-ownership table). A Marketplace requirement must be
   * satisfied by `marketplaceClinicDetail()` instead of editing this method.
   *
   * Contract C2a (lookup only, no response-shape change): `clinicId` may be a
   * UUID or a `tenants.slug` value — resolution is unambiguous, since a UUID
   * cannot collide with the slug format. The UUID path's query and behaviour
   * are byte-identical to before this change. An identifier that is neither a
   * valid UUID nor a matching slug 404s — never a 400 that would reveal which
   * format was expected.
   */
  async clinicDetail(clinicId: string) {
    const trimmed = clinicId.trim();
    const tenant = await this.dataSource.query(
      isUuid(trimmed)
        ? `SELECT t.id, t.name, t.slug, t.logo_url
             FROM tenants t
             LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
            WHERE t.id = $1::uuid AND ${ELIGIBLE_CLINIC}`
        : `SELECT t.id, t.name, t.slug, t.logo_url
             FROM tenants t
             LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
            WHERE t.slug = $1 AND ${ELIGIBLE_CLINIC}`,
      [trimmed],
    );
    if (!tenant[0])
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Clinic not found' });

    // Every downstream query in this method is keyed on the RESOLVED uuid, not
    // the caller-supplied identifier — a slug lookup must not leak into the
    // branch/service/doctor queries below, which are typed as ::uuid-shaped ids.
    clinicId = tenant[0].id as string;

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
   * Contract C2b — the Marketplace-facing clinic projection. A SEPARATE route
   * backed by a SEPARATE method (P3 remediation): `clinicDetail()` above is
   * frozen and AI-facing; nothing here changes what the assistant sees or
   * quotes. **Marketplace-facing — free to evolve.**
   *
   * P7 — every collection returns an explicit `total` and supports paging, so
   * a clinic with more than one page of branches/services/doctors never loses
   * entries silently the way the frozen method's `LIMIT 50` (no total) does.
   *
   * P3 — pricing is branch-scoped (`prices[]`), never the frozen method's
   * single clinic-wide `base_price`.
   *
   * Withheld per decision A1: `tenants.contact_email`.
   *
   * **Two known, documented gaps** (not silently worked around):
   *  - `services[].slug` is OMITTED. The `services` table has no slug column
   *    at all (verified against `Service.ts` — no migration ever added one),
   *    so `/clinics/[slug]/services/[serviceSlug]` (marketplace-routes.md)
   *    cannot be built until a dedicated migration adds and backfills one,
   *    the same way T060 does for doctors. Fabricating a derived, unpersisted
   *    slug here would collide across renames and duplicate names — worse
   *    than omitting the field.
   *  - `doctors[].slug` / `.avatarUrl` and the `specialties` array are empty/
   *    absent until T060/T061 (doctor slugs, Phase 8) and T051-T056
   *    (specialty domain, Phase 7) land — those fields do not exist in the
   *    schema yet. This method will be extended, not replaced, when they do.
   */
  async marketplaceClinicDetail(
    idOrSlug: string,
    pagination: {
      branchesPage?: number;
      branchesPageSize?: number;
      servicesPage?: number;
      servicesPageSize?: number;
      doctorsPage?: number;
      doctorsPageSize?: number;
    } = {},
  ) {
    const trimmed = idOrSlug.trim();
    const page = (v: number | undefined) => Math.max(1, v ?? 1);
    const size = (v: number | undefined) => Math.min(Math.max(1, v ?? 20), 50);

    const bPage = page(pagination.branchesPage);
    const bSize = size(pagination.branchesPageSize);
    const sPage = page(pagination.servicesPage);
    const sSize = size(pagination.servicesPageSize);
    const dPage = page(pagination.doctorsPage);
    const dSize = size(pagination.doctorsPageSize);

    const tenantRows = await this.dataSource.query(
      isUuid(trimmed)
        ? `SELECT t.id, t.name, t.slug, t.logo_url, t.contact_phone, t.default_currency, t.default_timezone
             FROM tenants t
             LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
            WHERE t.id = $1::uuid AND ${ELIGIBLE_CLINIC}`
        : `SELECT t.id, t.name, t.slug, t.logo_url, t.contact_phone, t.default_currency, t.default_timezone
             FROM tenants t
             LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
            WHERE t.slug = $1 AND ${ELIGIBLE_CLINIC}`,
      [trimmed],
    );
    const tenant = tenantRows[0];
    if (!tenant)
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Clinic not found' });

    const clinicId = tenant.id as string;

    const [branchRows, branchCount, serviceRows, serviceCount, doctorRows, doctorCount] =
      await Promise.all([
        this.dataSource.query(
          `SELECT b.id, b.name, b.address, b.phone, b.timezone, b.city_id, c.name_ar AS city_ar, c.name_en AS city_en
             FROM branches b
             LEFT JOIN cities c ON c.id = b.city_id
            WHERE b."tenantId" = $1 AND b.is_active = true AND b.deleted_at IS NULL
            ORDER BY b.name LIMIT $2 OFFSET $3`,
          [clinicId, bSize, (bPage - 1) * bSize],
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS total FROM branches
            WHERE "tenantId" = $1 AND is_active = true AND deleted_at IS NULL`,
          [clinicId],
        ),
        this.dataSource.query(
          `SELECT id, name, description, duration_minutes FROM services
            WHERE "tenantId" = $1 AND is_active = true AND deleted_at IS NULL
            ORDER BY name LIMIT $2 OFFSET $3`,
          [clinicId, sSize, (sPage - 1) * sSize],
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS total FROM services
            WHERE "tenantId" = $1 AND is_active = true AND deleted_at IS NULL`,
          [clinicId],
        ),
        this.dataSource.query(
          `SELECT sp.id, COALESCE(u.full_name, sp.title, 'Doctor') AS name, sp.title
             FROM staff_profiles sp
             LEFT JOIN users u ON u.id = sp.user_id AND u.deleted_at IS NULL AND u.is_active = true
            WHERE sp."tenantId" = $1
              AND sp.deleted_at IS NULL
              AND sp.is_available_for_booking = true
            ORDER BY name LIMIT $2 OFFSET $3`,
          [clinicId, dSize, (dPage - 1) * dSize],
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS total FROM staff_profiles
            WHERE "tenantId" = $1 AND deleted_at IS NULL AND is_available_for_booking = true`,
          [clinicId],
        ),
      ]);

    // Per-branch prices for exactly the services on this page — mirrors
    // BRANCH_OFFERS_SERVICE's "explicit configuration wins" rule: a service
    // with at least one active service_prices row is priced per-branch; a
    // service with none is priced everywhere at base_price. "Everywhere" means
    // every ACTIVE branch of the clinic, not just the current page of
    // branches (P7 — paginating branches must never silently truncate a
    // service's price list to whichever branches happen to be on this page).
    const serviceIds = serviceRows.map((s: Record<string, unknown>) => s.id as string);
    const [priceRows, allBranchRows]: [Record<string, unknown>[], Record<string, unknown>[]] =
      await Promise.all([
        serviceIds.length
          ? this.dataSource.query(
              `SELECT sp."serviceId" AS service_id, sp."branchId" AS branch_id, sp.price
                 FROM service_prices sp
                WHERE sp."serviceId" = ANY($1::uuid[]) AND sp.is_active = true`,
              [serviceIds],
            )
          : Promise.resolve([]),
        this.dataSource.query(
          `SELECT id FROM branches WHERE "tenantId" = $1 AND is_active = true AND deleted_at IS NULL`,
          [clinicId],
        ),
      ]);
    const pricesByService = new Map<string, { branchId: string; price: number }[]>();
    for (const row of priceRows) {
      const list = pricesByService.get(row.service_id as string) ?? [];
      list.push({ branchId: row.branch_id as string, price: n(row.price) });
      pricesByService.set(row.service_id as string, list);
    }
    const allBranchIds: string[] = allBranchRows.map((b) => b.id as string);

    return {
      clinic: {
        id: tenant.id as string,
        name: tenant.name as string,
        slug: tenant.slug as string,
        logoUrl: (tenant.logo_url as string) ?? null,
        phone: (tenant.contact_phone as string) ?? null,
        currency: tenant.default_currency as string,
        timezone: tenant.default_timezone as string,
      },
      branches: {
        items: branchRows.map((b: Record<string, unknown>) => ({
          id: b.id as string,
          name: b.name as string,
          address: (b.address as string) ?? null,
          city: b.city_id
            ? { nameAr: (b.city_ar as string) ?? null, nameEn: (b.city_en as string) ?? null }
            : null,
          phone: (b.phone as string) ?? null,
          timezone: (b.timezone as string) || 'UTC',
        })),
        total: n(branchCount[0]?.total),
        page: bPage,
        pageSize: bSize,
      },
      services: {
        items: serviceRows.map((s: Record<string, unknown>) => {
          const perBranch = pricesByService.get(s.id as string);
          const prices = perBranch?.length
            ? perBranch
            : allBranchIds.map((branchId) => ({ branchId, price: n(s.base_price) }));
          return {
            id: s.id as string,
            name: s.name as string,
            description: (s.description as string) ?? null,
            durationMinutes: n(s.duration_minutes),
            prices,
          };
        }),
        total: n(serviceCount[0]?.total),
        page: sPage,
        pageSize: sSize,
      },
      doctors: {
        items: doctorRows.map((d: Record<string, unknown>) => ({
          id: d.id as string,
          name: d.name as string,
          title: (d.title as string) ?? null,
          // slug/avatarUrl added once T060/T061 land (Phase 8) — see docstring.
        })),
        total: n(doctorCount[0]?.total),
        page: dPage,
        pageSize: dSize,
      },
      // Empty until the specialty domain model lands (T051-T056, Phase 7) —
      // omitted-as-empty, not stubbed with invented data (Constitution XXIII).
      specialties: [] as { slug: string; nameAr: string | null; nameEn: string | null }[],
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
    const tenantId = await this.tenantOfPublicBranch(branchId);

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

  /**
   * Public MULTI-DAY free-slot lookup — the same per-day computation as
   * {@link publicAvailability}, run across a range so a caller can answer "when
   * is this doctor next free?" instead of only "is he free on this exact day?".
   *
   * Tenant and branch/doctor pairing are validated identically; only the shape
   * of the answer differs. Slot computation stays entirely in
   * `AvailabilityService.rangeWindows`.
   */
  async publicRangeAvailability(
    branchId: string,
    staffId: string,
    params: {
      fromDate: string;
      toDate: string;
      slotMinutes?: number;
      maxDaysWithSlots?: number;
      notBefore?: Date;
    },
  ) {
    const tenantId = await this.tenantOfPublicBranch(branchId);
    await this.assertDoctorAtBranch(tenantId, branchId, staffId);
    return this.availability.rangeWindows(tenantId, {
      branchId,
      staffId,
      ...params,
    });
  }

  /**
   * WHERE a branch is and WHEN it is open — the two questions the assistant
   * could not answer at all, because nothing in the AI surface had ever read
   * `working_hours` and only `clinicDetail` exposed an address (during the
   * discovery step, long before "where are you?" is usually asked).
   *
   * `is_closed` vs. "no row at all" is reported EXPLICITLY, never collapsed:
   * a clinic that has not configured its hours must produce "the clinic has not
   * published its hours", not an invented schedule and not a false "we are
   * closed that day". That distinction is the whole point of `configured`.
   *
   * `tenantId` scopes the lookup for an AUTHENTICATED own-clinic caller (the
   * WhatsApp bot, which already represents exactly one clinic). Omitting it
   * selects the anonymous path, where the public eligibility predicate applies
   * instead — so a guest can only ever read a clinic that opted in.
   */
  async branchInfo(
    branchId: string,
    opts: { tenantId?: string } = {},
  ): Promise<{
    branch: {
      id: string;
      name: string;
      address: string | null;
      city: string | null;
      phone: string | null;
      whatsapp: string | null;
      timezone: string;
    };
    clinic: { id: string; name: string };
    workingHours: {
      dayOfWeek: number;
      day: string;
      status: 'OPEN' | 'CLOSED' | 'NOT_PUBLISHED';
      hours: { start: string; end: string }[];
    }[];
    workingHoursConfigured: boolean;
  }> {
    const scoped = opts.tenantId
      ? {
          clause: `AND b."tenantId" = $2::uuid`,
          params: [branchId, opts.tenantId],
        }
      : { clause: `AND ${ELIGIBLE_CLINIC}`, params: [branchId] };

    const rows = await this.dataSource.query(
      `SELECT b.id, b.name, b.address, b.phone, b.whatsapp_phone, b.timezone,
              b."tenantId" AS tenant_id, t.name AS clinic_name,
              COALESCE(c.name_ar, c.name_en) AS city
         FROM branches b
         JOIN tenants t ON t.id = b."tenantId"
         LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
         LEFT JOIN cities c ON c.id = b.city_id
        WHERE b.id = $1::uuid AND b.is_active = true AND b.deleted_at IS NULL
          ${scoped.clause}
        LIMIT 1`,
      scoped.params,
    );
    const row = rows[0];
    if (!row)
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });

    const hours = await this.dataSource.query(
      `SELECT day_of_week, start_time, end_time, is_closed
         FROM working_hours
        WHERE "branchId" = $1::uuid AND "tenantId" = $2::uuid
        ORDER BY day_of_week, start_time`,
      [branchId, row.tenant_id],
    );

    const byDay = new Map<number, Record<string, unknown>[]>();
    for (const h of hours as Record<string, unknown>[]) {
      const d = n(h.day_of_week);
      byDay.set(d, [...(byDay.get(d) ?? []), h]);
    }

    return {
      branch: {
        id: row.id as string,
        name: row.name as string,
        address: (row.address as string) ?? null,
        city: (row.city as string) ?? null,
        phone: (row.phone as string) ?? null,
        whatsapp: (row.whatsapp_phone as string) ?? null,
        timezone: (row.timezone as string) || 'UTC',
      },
      clinic: { id: row.tenant_id as string, name: row.clinic_name as string },
      workingHours: WEEKDAYS.map((day, dayOfWeek) => {
        const rowsForDay = byDay.get(dayOfWeek);
        if (!rowsForDay?.length) {
          return {
            dayOfWeek,
            day,
            status: 'NOT_PUBLISHED' as const,
            hours: [],
          };
        }
        const open = rowsForDay.filter((r) => r.is_closed !== true);
        return open.length
          ? {
              dayOfWeek,
              day,
              status: 'OPEN' as const,
              hours: open.map((r) => ({
                start: hhmm(r.start_time as string),
                end: hhmm(r.end_time as string),
              })),
            }
          : { dayOfWeek, day, status: 'CLOSED' as const, hours: [] };
      }),
      workingHoursConfigured: hours.length > 0,
    };
  }

  /**
   * A doctor's RECURRING weekly working pattern at a branch — the answer to
   * "when does Dr. X work?", which is a different question from "is Dr. X free
   * at 10:00 next Tuesday?" and was previously answered by running the second
   * one and reporting its failure.
   *
   * This is the SCHEDULE (which days and hours they are rostered), never the
   * AVAILABILITY (what is actually still free once bookings, blocks, holidays
   * and time off are subtracted). Callers that need bookable times must use
   * `publicRangeAvailability`; the returned `note` says so, because conflating
   * the two is precisely how a fully-booked Tuesday gets offered to a patient.
   */
  async doctorSchedule(
    tenantId: string,
    branchId: string,
    staffId: string,
  ): Promise<{
    doctor: { id: string; name: string; title: string | null };
    weekly: {
      dayOfWeek: number;
      day: string;
      hours: { start: string; end: string }[];
    }[];
    worksAtBranch: boolean;
    note: string;
  }> {
    await this.assertDoctorAtBranch(tenantId, branchId, staffId);

    const [profile] = await this.dataSource.query(
      `SELECT sp.id, COALESCE(u.full_name, sp.title, 'Doctor') AS name, sp.title
         FROM staff_profiles sp
         LEFT JOIN users u ON u.id = sp.user_id AND u.deleted_at IS NULL AND u.is_active = true
        WHERE sp.id = $2::uuid AND sp."tenantId" = $1::uuid AND sp.deleted_at IS NULL
        LIMIT 1`,
      [tenantId, staffId],
    );
    if (!profile)
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Doctor not found' });

    // Staff schedule ∩ branch open hours — the same intersection
    // `StaffScheduleService.getAvailability` performs per day, expressed here
    // as the weekly pattern. An unconfigured branch day imposes no constraint
    // (see that method's own note), so LEFT JOIN and fall back to the
    // schedule's own window rather than dropping the day.
    const rows = await this.dataSource.query(
      `SELECT ss.day_of_week,
              GREATEST(ss.start_time, COALESCE(wh.start_time, ss.start_time)) AS start_time,
              LEAST(ss.end_time,   COALESCE(wh.end_time,   ss.end_time))   AS end_time
         FROM staff_schedules ss
         LEFT JOIN working_hours wh
                ON wh."branchId" = ss."branchId"
               AND wh.day_of_week = ss.day_of_week
               AND wh.is_closed = false
        WHERE ss."staffId" = $2::uuid
          AND ss."tenantId" = $1::uuid
          AND ss."branchId" = $3::uuid
          AND ss.is_active = true
          AND NOT EXISTS (
                SELECT 1 FROM working_hours whc
                 WHERE whc."branchId" = ss."branchId"
                   AND whc.day_of_week = ss.day_of_week
                   AND whc.is_closed = true)
        ORDER BY ss.day_of_week, start_time`,
      [tenantId, staffId, branchId],
    );

    const byDay = new Map<number, { start: string; end: string }[]>();
    for (const r of rows as Record<string, unknown>[]) {
      const d = n(r.day_of_week);
      const start = hhmm(r.start_time as string);
      const end = hhmm(r.end_time as string);
      if (start >= end) continue; // schedule and branch hours do not overlap
      byDay.set(d, [...(byDay.get(d) ?? []), { start, end }]);
    }

    return {
      doctor: {
        id: profile.id as string,
        name: profile.name as string,
        title: (profile.title as string) ?? null,
      },
      weekly: [...byDay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([dayOfWeek, hours]) => ({
          dayOfWeek,
          day: WEEKDAYS[dayOfWeek],
          hours,
        })),
      worksAtBranch: true,
      note: 'This is the recurring roster, not free time. Existing bookings, blocked periods, holidays and leave are NOT subtracted — use the availability tool for bookable slots.',
    };
  }

  /** Owning tenant of a branch that is publicly bookable RIGHT NOW. Fails closed. */
  private async tenantOfPublicBranch(branchId: string): Promise<string> {
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
    return tenantId;
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

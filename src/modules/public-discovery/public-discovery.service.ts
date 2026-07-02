import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Public (anonymous) clinic discovery for the website chat widget.
 *
 * READ-ONLY, cross-tenant, and STRICTLY limited to public marketing fields of
 * APPROVED + active clinics (name/slug/logo, branch names/cities, service
 * names/prices, doctor titles). It never exposes private tenant data (patients,
 * finance, settings, contacts) and never mutates anything — so it is safe to
 * serve unauthenticated. Booking itself still runs through the tenant's own
 * authenticated flow once a clinic is chosen.
 */
@Injectable()
export class PublicDiscoveryService {
  constructor(private readonly dataSource: DataSource) {}

  /** Search public clinics by name/slug or an offered service (e.g. "dentist"). */
  async searchClinics(query: string | undefined, limit = 12) {
    const like = query?.trim() ? `%${query.trim()}%` : null;
    const rows = await this.dataSource.query(
      `SELECT t.id, t.name, t.slug, t.logo_url,
              (SELECT COUNT(*)::int FROM branches b WHERE b."tenantId" = t.id AND b.is_active = true) AS branches,
              (SELECT string_agg(x.name, ', ') FROM (
                 SELECT name FROM services WHERE "tenantId" = t.id AND is_active = true ORDER BY name LIMIT 4
               ) x) AS services
         FROM tenants t
        WHERE t.approval_status = 'APPROVED' AND t.is_active = true AND t.deleted_at IS NULL
          AND ($1::text IS NULL
               OR t.name ILIKE $1 OR t.slug ILIKE $1
               OR EXISTS (SELECT 1 FROM services sv WHERE sv."tenantId" = t.id AND sv.is_active = true AND sv.name ILIKE $1))
        ORDER BY t.name ASC
        LIMIT $2`,
      [like, Math.min(limit, 24)],
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

  /** Public detail for a chosen clinic: branches, services (+price), doctors. */
  async clinicDetail(clinicId: string) {
    const tenant = await this.dataSource.query(
      `SELECT id, name, slug, logo_url FROM tenants
        WHERE id = $1 AND approval_status = 'APPROVED' AND is_active = true AND deleted_at IS NULL`,
      [clinicId],
    );
    if (!tenant[0]) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Clinic not found' });

    const [branches, services, doctors] = await Promise.all([
      this.dataSource.query(
        `SELECT id, name, city_id FROM branches WHERE "tenantId" = $1 AND is_active = true ORDER BY name LIMIT 50`,
        [clinicId],
      ),
      this.dataSource.query(
        `SELECT id, name, base_price FROM services WHERE "tenantId" = $1 AND is_active = true ORDER BY name LIMIT 50`,
        [clinicId],
      ),
      this.dataSource.query(
        `SELECT sp.id, COALESCE(u.full_name, sp.title, 'Doctor') AS name, sp.title
           FROM staff_profiles sp LEFT JOIN users u ON u.id = sp.user_id
          WHERE sp."tenantId" = $1 ORDER BY name LIMIT 50`,
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
      branches: branches.map((b: Record<string, unknown>) => ({ id: b.id as string, name: b.name as string })),
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
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';

import { SupportClinicResolver } from './support-clinic.resolver';
import { isoOrNull } from './support-privacy.util';

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Clinic Support Profile + safe configuration diagnostics.
 *
 * Two allow-listed projections, both built by MAPPING selected columns — never
 * by serialising an entity and deleting fields. The difference matters: a
 * delete-list silently starts leaking the next column somebody adds, an
 * allow-list silently omits it.
 *
 * Deliberately absent from both responses, and not queried at all:
 * `logo_url`-adjacent verification documents, `commercial_registration_number`
 * / `legal_name` (identity documents, not operational state), any payment or
 * merchant configuration, any API key or webhook secret, and every field of
 * `tenants` not named in `SupportClinicResolver.resolve`'s `select`.
 */
@Injectable()
export class ClinicSupportProfileService {
  constructor(
    private readonly clinics: SupportClinicResolver,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    @InjectRepository(TenantSetting)
    private readonly settings: Repository<TenantSetting>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Operational identity + structure for the clinic behind a ticket.
   *
   * Three queries total (clinic, branches, one aggregate row) regardless of how
   * many branches or staff the clinic has — the counts are computed by the
   * database in a single statement rather than by loading rows, so this cannot
   * degrade into an N+1 as a clinic grows.
   */
  async profile(tenantId: string) {
    const clinic = await this.clinics.resolve(tenantId);

    const [branches, counts] = await Promise.all([
      this.branches.find({
        where: { tenant: { id: tenantId } },
        select: { id: true, name: true, is_active: true, timezone: true },
        order: { name: 'ASC' },
      }),
      this.structureCounts(tenantId),
    ]);

    return {
      clinic: {
        id: clinic.id,
        name: clinic.name,
        slug: clinic.slug,
        isActive: clinic.is_active,
        approvalStatus: clinic.approval_status,
        createdAt: isoOrNull(clinic.created_at),
        timezone: clinic.default_timezone,
        currency: clinic.default_currency,
        // Clinic CONTACT details, not a patient's — the clinic is the party
        // Support is corresponding with, so these are unmasked exactly as they
        // already are on the ticket-detail response.
        contactEmail: clinic.contact_email ?? null,
        contactPhone: clinic.contact_phone ?? null,
      },
      structure: {
        branchesTotal: branches.length,
        branchesActive: branches.filter((b) => b.is_active).length,
        branches: branches.map((b) => ({
          id: b.id,
          name: b.name,
          isActive: b.is_active,
          timezone: b.timezone,
        })),
        activeStaffCount: counts.activeStaff,
        bookableStaffCount: counts.bookableStaff,
        activeServiceCount: counts.activeServices,
        staffWithSchedulesCount: counts.staffWithSchedules,
      },
    };
  }

  /**
   * Safe operational configuration — the settings that actually EXPLAIN
   * observed platform behaviour ("why can't patients book online?", "why is
   * the bot silent?", "why is payment being demanded?").
   *
   * `tenant_settings` holds no credentials at all today, but this still returns
   * a mapped subset rather than the row: the table is a natural home for a
   * future integration toggle that carries one, and this projection must not
   * start emitting it by default.
   */
  async configuration(tenantId: string) {
    await this.clinics.assertExists(tenantId);

    const [row, counts] = await Promise.all([
      this.settings.findOne({
        where: { tenant: { id: tenantId } },
        select: {
          id: true,
          booking_confirmation: true,
          payment_required: true,
          cancellation_hours: true,
          feedback_delay_minutes: true,
          default_language: true,
          currency: true,
          bot_enabled: true,
          public_booking_enabled: true,
          updated_at: true,
        },
      }),
      this.structureCounts(tenantId),
    ]);

    if (!row) {
      // A clinic with no settings row is itself the diagnosis (onboarding never
      // completed), so this is a legitimate state to report — not a 404.
      return {
        configured: false,
        settings: null,
        readiness: this.readiness(null, counts),
      };
    }

    return {
      configured: true,
      settings: {
        bookingConfirmation: row.booking_confirmation,
        paymentRequired: row.payment_required,
        cancellationHours: row.cancellation_hours,
        feedbackDelayMinutes: row.feedback_delay_minutes,
        defaultLanguage: row.default_language,
        currency: row.currency,
        botEnabled: row.bot_enabled,
        publicBookingEnabled: row.public_booking_enabled,
        updatedAt: isoOrNull(row.updated_at),
      },
      readiness: this.readiness(row, counts),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * One statement, four scalar subqueries. Written as raw SQL rather than four
   * `repository.count()` calls because a diagnostic page must not cost four
   * round trips per section, and because these counts are pure aggregates with
   * no entity mapping to gain from the ORM.
   *
   * `staff_profiles` has no `is_active` of its own — staff liveness lives on
   * the linked `users` row, which is why the first two counts join it.
   */
  private async structureCounts(tenantId: string): Promise<StructureCounts> {
    const [row] = await this.dataSource.query(
      `
      SELECT
        (SELECT COUNT(*) FROM staff_profiles sp
           JOIN users u ON u.id = sp.user_id
          WHERE sp."tenantId" = $1 AND sp.deleted_at IS NULL
            AND u.is_active = true AND u.deleted_at IS NULL
        )::int AS active_staff,
        (SELECT COUNT(*) FROM staff_profiles sp
           JOIN users u ON u.id = sp.user_id
          WHERE sp."tenantId" = $1 AND sp.deleted_at IS NULL
            AND u.is_active = true AND u.deleted_at IS NULL
            AND sp.is_available_for_booking = true
        )::int AS bookable_staff,
        (SELECT COUNT(*) FROM services s
          WHERE s."tenantId" = $1 AND s.is_active = true AND s.deleted_at IS NULL
        )::int AS active_services,
        (SELECT COUNT(DISTINCT ss."staffId") FROM staff_schedules ss
          WHERE ss."tenantId" = $1
        )::int AS staff_with_schedules
      `,
      [tenantId],
    );
    return {
      activeStaff: int(row?.active_staff),
      bookableStaff: int(row?.bookable_staff),
      activeServices: int(row?.active_services),
      staffWithSchedules: int(row?.staff_with_schedules),
    };
  }

  /**
   * Derived "can this clinic actually take a booking?" checklist. Pure
   * composition of values already returned above — no new source of truth, and
   * no entitlement logic (that belongs to `FeatureResolverService`, surfaced by
   * the feature-diagnostics endpoint).
   */
  private readiness(
    settings: Pick<TenantSetting, 'public_booking_enabled' | 'payment_required'> | null,
    counts: StructureCounts,
  ) {
    return {
      hasBookableStaff: counts.bookableStaff > 0,
      hasActiveServices: counts.activeServices > 0,
      hasSchedules: counts.staffWithSchedules > 0,
      publicBookingEnabled: settings?.public_booking_enabled ?? false,
      paymentRequired: settings?.payment_required ?? null,
    };
  }
}

interface StructureCounts {
  activeStaff: number;
  bookableStaff: number;
  activeServices: number;
  staffWithSchedules: number;
}

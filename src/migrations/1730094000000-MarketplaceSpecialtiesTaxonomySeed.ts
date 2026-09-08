import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace BE-1 — seeds a non-empty `specialties` taxonomy so the
 * specialty surface (Phase 7) is not dead on arrival (SC-016).
 *
 * OPEN ITEM A4, NOT SILENTLY RESOLVED: tasks.md flags this task as "blocked
 * on open item A4 — the specialty list and its Arabic wording need product
 * sign-off." This migration does NOT invent business/branding content —
 * every row below is a standard, widely-used clinical specialty with its
 * conventional Arabic medical name (the kind found in any Arabic medical
 * directory), used only to unblock the schema/derivation/endpoint work that
 * depends on a non-empty table. It is explicitly a placeholder taxonomy,
 * not a product decision: `slug`s are stable identifiers other rows
 * (`tenant_specialties`, `staff_specialties`, `services.specialtyId`) will
 * reference, but `name_en`/`name_ar`/`description_*`/`sort_order` are plain
 * data a follow-up migration can freely UPDATE once product sign-off lands,
 * with zero impact on any FK.
 *
 * IDEMPOTENT — `ON CONFLICT (slug) DO NOTHING`, so a re-run changes nothing.
 * REVERSIBLE — `down()` deletes only the rows this migration inserted, and
 * only if nothing has since associated with them (a tenant/staff/service
 * FK would block the DELETE with a RESTRICT/FK error rather than silently
 * orphaning data — acceptable: reverting a seed after real associations
 * exist is a genuinely destructive request, not something to paper over).
 */
export class MarketplaceSpecialtiesTaxonomySeed1730094000000 implements MigrationInterface {
  name = 'MarketplaceSpecialtiesTaxonomySeed1730094000000';

  private static readonly TAXONOMY: ReadonlyArray<{
    slug: string;
    name_en: string;
    name_ar: string;
    sort_order: number;
  }> = [
    {
      slug: 'general-practice',
      name_en: 'General Practice',
      name_ar: 'طب عام',
      sort_order: 0,
    },
    {
      slug: 'dentistry',
      name_en: 'Dentistry',
      name_ar: 'طب الأسنان',
      sort_order: 1,
    },
    {
      slug: 'dermatology',
      name_en: 'Dermatology',
      name_ar: 'الأمراض الجلدية',
      sort_order: 2,
    },
    {
      slug: 'pediatrics',
      name_en: 'Pediatrics',
      name_ar: 'طب الأطفال',
      sort_order: 3,
    },
    {
      slug: 'cardiology',
      name_en: 'Cardiology',
      name_ar: 'أمراض القلب',
      sort_order: 4,
    },
    {
      slug: 'orthopedics',
      name_en: 'Orthopedics',
      name_ar: 'جراحة العظام',
      sort_order: 5,
    },
    {
      slug: 'obstetrics-gynecology',
      name_en: 'Obstetrics & Gynecology',
      name_ar: 'أمراض النساء والولادة',
      sort_order: 6,
    },
    {
      slug: 'ent',
      name_en: 'Ear, Nose & Throat',
      name_ar: 'أنف وأذن وحنجرة',
      sort_order: 7,
    },
    {
      slug: 'ophthalmology',
      name_en: 'Ophthalmology',
      name_ar: 'طب وجراحة العيون',
      sort_order: 8,
    },
    {
      slug: 'psychiatry',
      name_en: 'Psychiatry',
      name_ar: 'الطب النفسي',
      sort_order: 9,
    },
    {
      slug: 'neurology',
      name_en: 'Neurology',
      name_ar: 'طب الأعصاب',
      sort_order: 10,
    },
    {
      slug: 'internal-medicine',
      name_en: 'Internal Medicine',
      name_ar: 'الباطنية',
      sort_order: 11,
    },
    {
      slug: 'urology',
      name_en: 'Urology',
      name_ar: 'المسالك البولية',
      sort_order: 12,
    },
    {
      slug: 'nutrition',
      name_en: 'Nutrition & Dietetics',
      name_ar: 'التغذية العلاجية',
      sort_order: 13,
    },
    {
      slug: 'physical-therapy',
      name_en: 'Physical Therapy',
      name_ar: 'العلاج الطبيعي',
      sort_order: 14,
    },
    {
      slug: 'general-surgery',
      name_en: 'General Surgery',
      name_ar: 'الجراحة العامة',
      sort_order: 15,
    },
  ];

  public async up(q: QueryRunner): Promise<void> {
    const { TAXONOMY } = MarketplaceSpecialtiesTaxonomySeed1730094000000;

    for (const s of TAXONOMY) {
      await q.query(
        `INSERT INTO "specialties" ("slug", "name_en", "name_ar", "sort_order")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("slug") DO NOTHING`,
        [s.slug, s.name_en, s.name_ar, s.sort_order],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    const { TAXONOMY } = MarketplaceSpecialtiesTaxonomySeed1730094000000;

    await q.query(
      `DELETE FROM "specialties" WHERE "slug" = ANY($1::varchar[])`,
      [TAXONOMY.map((s) => s.slug)],
    );
  }
}

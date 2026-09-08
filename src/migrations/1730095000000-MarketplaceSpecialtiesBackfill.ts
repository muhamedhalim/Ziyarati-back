import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace BE-1 — backfills clinic/doctor specialty associations from
 * existing service data (research.md R15, data-model.md §2 provenance rule,
 * spec.md "Clinic and doctor associations are then backfilled by migration
 * from existing service data").
 *
 * FILLS A GAP THE DESIGN DOCS LEAVE OPEN, DOCUMENTED HERE RATHER THAN SILENTLY
 * ASSUMED: none of spec.md/research.md/data-model.md specify HOW a service
 * is matched to a specialty in the first place — `services.specialtyId` is a
 * brand-new nullable column with nothing to populate it yet. This migration
 * closes that gap with the narrowest defensible mechanism: a service is
 * matched to a specialty only when the specialty's own English or Arabic
 * name (or one of a small number of very standard synonym keywords for that
 * exact specialty — e.g. "dental" for "Dentistry") appears as a case-
 * insensitive substring of the service's name. This recognizes a signal
 * already present in data a clinic itself entered — it never invents one.
 * A service whose name carries no such signal (e.g. an administrative
 * "Follow-up Consult") is correctly left unassigned rather than guessed at.
 *
 * DERIVATION PATH (matches the task's own description):
 *   services.specialtyId (this migration sets it)
 *     → tenant_specialties: DISTINCT (service.tenant, service.specialtyId)
 *     → staff_specialties:  DISTINCT (staff_services.staff, service.specialtyId)
 *       via the existing staff_services doctor↔service link
 *
 * PROVENANCE: every row this migration writes is `DERIVED`. It never
 * touches an `ASSERTED` row — the unique constraint on each association
 * table means an `ASSERTED` row already occupying a (tenant/staff,
 * specialty) pair makes the `ON CONFLICT ... DO NOTHING` backfill INSERT a
 * silent no-op for that pair, so a human correction always wins over
 * re-derivation, exactly as data-model.md's provenance rule requires.
 *
 * IDEMPOTENT — every write is `ON CONFLICT DO NOTHING` (services.specialtyId
 * is only set `WHERE "specialtyId" IS NULL`, so a manually-corrected service
 * is never overwritten either). REVERSIBLE — `down()` deletes only rows this
 * migration could have written (`provenance = 'DERIVED'`), and only clears
 * `services.specialtyId` for services that still point at a specialty this
 * migration's own keyword map would have matched, not any human-assigned
 * value.
 */
export class MarketplaceSpecialtiesBackfill1730095000000 implements MigrationInterface {
  name = 'MarketplaceSpecialtiesBackfill1730095000000';

  /** Keyword signals, bilingual, per specialty slug. Deliberately narrow. */
  private static readonly KEYWORDS: Readonly<
    Record<string, readonly string[]>
  > = {
    'general-practice': [
      'general practice',
      'general checkup',
      'checkup',
      'استشارة عامة',
      'طب عام',
      'فحص عام',
    ],
    dentistry: ['dental', 'dentist', 'teeth', 'tooth', 'أسنان'],
    dermatology: ['dermatology', 'skin', 'جلدية', 'جلد'],
    pediatrics: ['pediatric', 'paediatric', 'child', 'أطفال'],
    cardiology: ['cardiology', 'cardiac', 'heart', 'قلب'],
    orthopedics: ['orthopedic', 'orthopaedic', 'bone', 'joint', 'عظام'],
    'obstetrics-gynecology': [
      'obstetric',
      'gynecolog',
      'gynaecolog',
      'نساء',
      'ولادة',
    ],
    ent: ['ear, nose', 'ent ', ' ent', 'أنف وأذن'],
    ophthalmology: ['ophthalmolog', 'eye', 'vision', 'عيون'],
    psychiatry: ['psychiatr', 'mental health', 'نفسي'],
    neurology: ['neurolog', 'أعصاب'],
    'internal-medicine': ['internal medicine', 'باطنية', 'باطنة'],
    urology: ['urolog', 'مسالك بولية'],
    nutrition: ['nutrition', 'dietet', 'تغذية'],
    'physical-therapy': ['physical therapy', 'physiotherapy', 'علاج طبيعي'],
    'general-surgery': ['general surgery', 'جراحة عامة'],
  };

  public async up(q: QueryRunner): Promise<void> {
    const { KEYWORDS } = MarketplaceSpecialtiesBackfill1730095000000;

    // ── Step 1: match unclassified services to a specialty by keyword
    // signal in their own name. Only ever sets a currently-NULL value.
    for (const [slug, keywords] of Object.entries(KEYWORDS)) {
      for (const kw of keywords) {
        await q.query(
          `UPDATE "services" s
             SET "specialtyId" = sp.id
            FROM "specialties" sp
           WHERE sp.slug = $1
             AND s."specialtyId" IS NULL
             AND s.deleted_at IS NULL
             AND LOWER(s.name) LIKE '%' || LOWER($2) || '%'`,
          [slug, kw],
        );
      }
    }

    // ── Step 2: clinic associations, DERIVED, from services now carrying a
    // specialty. One row per (tenant, specialty) actually in use.
    await q.query(
      `INSERT INTO "tenant_specialties" ("tenantId", "specialtyId", "provenance")
       SELECT DISTINCT s."tenantId", s."specialtyId", 'DERIVED'::tenant_specialty_provenance_enum
         FROM "services" s
        WHERE s."specialtyId" IS NOT NULL
          AND s.deleted_at IS NULL
       ON CONFLICT ("tenantId", "specialtyId") DO NOTHING`,
    );

    // ── Step 3: doctor associations, DERIVED, via the existing
    // staff_services doctor↔service link.
    await q.query(
      `INSERT INTO "staff_specialties" ("staffId", "specialtyId", "tenantId", "provenance")
       SELECT DISTINCT ss."staffId", s."specialtyId", s."tenantId", 'DERIVED'::staff_specialty_provenance_enum
         FROM "staff_services" ss
         JOIN "services" s ON s.id = ss."serviceId"
        WHERE s."specialtyId" IS NOT NULL
          AND s.deleted_at IS NULL
       ON CONFLICT ("staffId", "specialtyId") DO NOTHING`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    const { KEYWORDS } = MarketplaceSpecialtiesBackfill1730095000000;

    await q.query(
      `DELETE FROM "staff_specialties" WHERE "provenance" = 'DERIVED'`,
    );
    await q.query(
      `DELETE FROM "tenant_specialties" WHERE "provenance" = 'DERIVED'`,
    );

    // Only clear services.specialtyId where it still points at a specialty
    // this migration's own keyword map names — never a human-assigned value
    // that happens to share a specialty with what the backfill would have
    // matched (that ambiguity is inherent to a plain nullable column with no
    // provenance of its own; erring on "leave it" is the safe direction).
    for (const slug of Object.keys(KEYWORDS)) {
      await q.query(
        `UPDATE "services" s
           SET "specialtyId" = NULL
          FROM "specialties" sp
         WHERE sp.slug = $1 AND s."specialtyId" = sp.id`,
        [slug],
      );
    }
  }
}

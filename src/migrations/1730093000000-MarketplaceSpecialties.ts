import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace BE-1 — the platform-owned `specialties` lookup and its two
 * association tables (`tenant_specialties`, `staff_specialties`), plus a
 * nullable `services.specialtyId` FK. Modelled on the `cities` precedent:
 * no tenant column on `specialties` itself, hidden via `is_active` rather
 * than soft-deleted so associations survive a specialty being hidden.
 * Self-sufficient — does not assume a seeded environment (the taxonomy seed
 * is a separate, idempotent data migration).
 */
export class MarketplaceSpecialties1730093000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "specialties" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying(120) NOT NULL,
        "name_en" character varying(120) NOT NULL,
        "name_ar" character varying(120) NOT NULL,
        "description_en" text,
        "description_ar" text,
        "is_active" boolean NOT NULL DEFAULT true,
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_specialties" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_specialties_slug" UNIQUE ("slug")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_specialties_active_sort" ON "specialties" ("is_active", "sort_order")`,
    );

    await q.query(
      `CREATE TYPE "tenant_specialty_provenance_enum" AS ENUM ('DERIVED', 'ASSERTED')`,
    );
    await q.query(`
      CREATE TABLE "tenant_specialties" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "specialtyId" uuid NOT NULL,
        "provenance" "tenant_specialty_provenance_enum" NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_specialties" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tenant_specialties_tenant_specialty" UNIQUE ("tenantId", "specialtyId"),
        CONSTRAINT "FK_tenant_specialties_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tenant_specialties_specialty" FOREIGN KEY ("specialtyId")
          REFERENCES "specialties"("id") ON DELETE RESTRICT
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_tenant_specialties_specialty" ON "tenant_specialties" ("specialtyId")`,
    );
    await q.query(
      `CREATE INDEX "IDX_tenant_specialties_tenant" ON "tenant_specialties" ("tenantId")`,
    );

    await q.query(
      `CREATE TYPE "staff_specialty_provenance_enum" AS ENUM ('DERIVED', 'ASSERTED')`,
    );
    await q.query(`
      CREATE TABLE "staff_specialties" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "staffId" uuid NOT NULL,
        "specialtyId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "provenance" "staff_specialty_provenance_enum" NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_specialties" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_staff_specialties_staff_specialty" UNIQUE ("staffId", "specialtyId"),
        CONSTRAINT "FK_staff_specialties_staff" FOREIGN KEY ("staffId")
          REFERENCES "staff_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_specialties_specialty" FOREIGN KEY ("specialtyId")
          REFERENCES "specialties"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_staff_specialties_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_staff_specialties_specialty" ON "staff_specialties" ("specialtyId")`,
    );

    await q.query(`ALTER TABLE "services" ADD COLUMN "specialtyId" uuid`);
    await q.query(`
      ALTER TABLE "services" ADD CONSTRAINT "FK_services_specialty"
        FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE SET NULL
    `);
    await q.query(
      `CREATE INDEX "IDX_services_specialty" ON "services" ("specialtyId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IDX_services_specialty"`);
    await q.query(
      `ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "FK_services_specialty"`,
    );
    await q.query(`ALTER TABLE "services" DROP COLUMN IF EXISTS "specialtyId"`);

    await q.query(`DROP TABLE IF EXISTS "staff_specialties"`);
    await q.query(`DROP TYPE IF EXISTS "staff_specialty_provenance_enum"`);

    await q.query(`DROP TABLE IF EXISTS "tenant_specialties"`);
    await q.query(`DROP TYPE IF EXISTS "tenant_specialty_provenance_enum"`);

    await q.query(`DROP TABLE IF EXISTS "specialties"`);
  }
}

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Public shape of a branch's city — mirrors the `cities` lookup row. */
export interface BranchCity {
  id: string;
  name_ar: string | null;
  name_en: string | null;
}

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿ]/;

/**
 * Owns the branch → `cities` lookup. `branches.city_id` is the platform's one
 * city concept (the public marketplace/AI read it through `public-discovery`),
 * but nothing let a clinic write it: the FK wants a UUID and no endpoint listed
 * cities. This turns the human-readable name the owner types ("Riyadh",
 * "الرياض", "Nasr City") into that FK — reusing the existing row when the city
 * is already known so the marketplace shows one entry per city, not one per
 * clinic that spelled it.
 *
 * `cities` is a global (non-tenant) table, so callers must authorise the write
 * themselves; this service only resolves names.
 */
@Injectable()
export class BranchCityService {
  constructor(private readonly dataSource: DataSource) {}

  /** Trim + collapse inner whitespace so "  Nasr   City " and "Nasr City" match. */
  static normalize(name: string): string {
    return name.trim().replace(/\s+/g, ' ');
  }

  /**
   * Find-or-create the city called `name`, returning its id.
   *
   * A name containing Arabic script is stored in `name_ar`, anything else in
   * `name_en`; matching is case-insensitive on that same column. A
   * transaction-scoped advisory lock serialises concurrent creators of the same
   * name (there is deliberately no unique index — legacy data may already hold
   * duplicates, and a migration must not risk failing on them).
   */
  async resolveByName(
    name: string,
    countryId?: number | null,
  ): Promise<string> {
    const clean = BranchCityService.normalize(name);
    const column = ARABIC_SCRIPT.test(clean) ? 'name_ar' : 'name_en';

    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `cities:${clean.toLowerCase()}`,
      ]);
      const existing: { id: string }[] = await manager.query(
        `SELECT id FROM cities WHERE LOWER(${column}) = LOWER($1)
          ORDER BY created_at ASC LIMIT 1`,
        [clean],
      );
      if (existing[0]) return existing[0].id;

      const created: { id: string }[] = await manager.query(
        `INSERT INTO cities (${column}, "countryId") VALUES ($1, $2) RETURNING id`,
        [clean, countryId ?? null],
      );
      return created[0].id;
    });
  }

  /** True when a `cities` row with this id exists. */
  async exists(cityId: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM cities WHERE id = $1::uuid LIMIT 1`,
      [cityId],
    );
    return rows.length > 0;
  }

  /** Batch-loads city rows by id — one query for a whole branch list. */
  async loadByIds(ids: string[]): Promise<Map<string, BranchCity>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows: BranchCity[] = await this.dataSource.query(
      `SELECT id, name_ar, name_en FROM cities WHERE id = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }
}

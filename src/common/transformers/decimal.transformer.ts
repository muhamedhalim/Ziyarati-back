import { ValueTransformer } from 'typeorm';

/**
 * TypeORM returns `numeric`/`decimal` columns as STRINGS (to preserve precision),
 * so an entity field typed `number` is actually a string at runtime — a classic
 * source of `total + fee` string-concatenation bugs. This transformer parses on
 * read so the field is a real `number` (or null), and passes through on write.
 *
 * Note: JS `number` is float64 — fine for money up to ~2^53 minor units. For
 * very large monetary aggregates prefer keeping the string; for per-appointment
 * amounts this is safe and removes the footgun.
 */
export const decimalTransformer: ValueTransformer = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null => {
    if (value === null || value === undefined) return null;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  },
};

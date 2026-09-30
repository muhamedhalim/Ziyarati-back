import { Transform } from 'class-transformer';

/**
 * Parses a boolean QUERY-STRING value correctly.
 *
 * `@Type(() => Boolean)` — and the global `enableImplicitConversion`, which
 * fires for any property whose reflected TS type is `boolean` — both run
 * `Boolean(value)`, and `Boolean('false') === true`. A `?isActive=false` filter
 * therefore silently behaved as `true`.
 *
 * By the time a `@Transform` callback runs, implicit conversion has ALREADY
 * replaced `value`, so this reads the RAW input off `obj[key]` instead. It
 * accepts only the literal strings `'true'`/`'false'` (and real booleans, for
 * JSON bodies) and passes anything else through untouched, so `@IsBoolean()`
 * rejects it with a 400 rather than coercing garbage.
 *
 * Use as `@QueryBoolean() @IsBoolean() flag?: boolean;` — in that order, so
 * the transform runs before validation.
 */
export const QueryBoolean = (): PropertyDecorator =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    if (raw === 'true' || raw === true) return true;
    if (raw === 'false' || raw === false) return false;
    return raw;
  });

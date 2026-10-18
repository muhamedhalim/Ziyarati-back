import { isEmail } from 'class-validator';

import type { XlsxImportColumn } from '../../common/import/xlsx-row-parser';
import {
  CLINIC_IMPORT_LIMITS as LIMIT,
  type ClinicImportConflict,
  type ClinicImportRowStatus,
} from './clinic-import.constants';

/**
 * Pure parsing / validation / classification of clinic-import rows — no I/O, so
 * every rule is unit-testable and the preview and the commit run the SAME code.
 *
 * Header matching is an exact, case-insensitive lookup in each column's alias
 * list. There is deliberately no fuzzy matching: a mislabelled column must stop
 * the import, not silently feed the wrong data into an owner's email.
 */
export const CLINIC_IMPORT_COLUMNS: readonly XlsxImportColumn[] = [
  {
    field: 'clinicName',
    headers: ['clinic_name', 'clinic name', 'name', 'اسم العيادة'],
    required: true,
  },
  {
    field: 'ownerName',
    headers: ['owner_name', 'owner name', 'owner full name', 'اسم المالك'],
    required: true,
  },
  {
    field: 'ownerEmail',
    headers: ['owner_email', 'owner email', 'email', 'البريد الإلكتروني'],
    required: true,
  },
  {
    field: 'commercialRegistration',
    headers: [
      'commercial_registration_number',
      'commercial registration number',
      'commercial_registration',
      'cr_number',
      'cr number',
      'السجل التجاري',
    ],
    required: true,
  },
  {
    field: 'slug',
    headers: ['clinic_slug', 'clinic slug', 'slug'],
    required: false,
  },
  {
    field: 'ownerPhone',
    headers: ['owner_phone', 'owner phone', 'phone', 'mobile', 'الهاتف'],
    required: false,
  },
  {
    field: 'clinicEmail',
    headers: ['clinic_email', 'clinic email', 'contact_email', 'contact email'],
    required: false,
  },
  {
    field: 'clinicPhone',
    headers: ['clinic_phone', 'clinic phone', 'contact_phone', 'contact phone'],
    required: false,
  },
  {
    field: 'legalName',
    headers: ['legal_name', 'legal name'],
    required: false,
  },
  {
    field: 'currency',
    headers: ['default_currency', 'default currency', 'currency'],
    required: false,
  },
  {
    field: 'timezone',
    headers: ['default_timezone', 'default timezone', 'timezone'],
    required: false,
  },
  {
    field: 'salesRepEmail',
    headers: ['sales_rep_email', 'sales rep email', 'sales_rep', 'sales rep'],
    required: false,
  },
] as const;

export interface RawClinicRow {
  /** 1-based spreadsheet row (the header is row 1). */
  row: number;
  clinicName?: string;
  ownerName?: string;
  ownerEmail?: string;
  commercialRegistration?: string;
  slug?: string;
  ownerPhone?: string;
  clinicEmail?: string;
  clinicPhone?: string;
  legalName?: string;
  currency?: string;
  timezone?: string;
  salesRepEmail?: string;
}

export type ClinicFieldCode =
  | 'required'
  | 'too_long'
  | 'invalid_email'
  | 'invalid_phone'
  | 'invalid_slug'
  | 'slug_not_derivable'
  | 'invalid_registration'
  | 'invalid_currency'
  | 'invalid_timezone'
  | 'invalid_text';

export interface ClinicFieldError {
  /** Canonical column header the problem belongs to. */
  field: string;
  code: ClinicFieldCode;
}

/** The normalised values a valid row would create. */
export interface ClinicValues {
  clinicName: string;
  ownerName: string;
  ownerEmail: string;
  commercialRegistration: string;
  slug: string;
  ownerPhone?: string;
  /** Tenant `contact_email` — the owner's email unless the row gives one. */
  clinicEmail: string;
  clinicPhone?: string;
  legalName?: string;
  currency?: string;
  timezone?: string;
  salesRepEmail?: string;
}

export interface ParsedClinicRow {
  row: number;
  values: ClinicValues | null;
  /** What the row said, for display when `values` could not be built. */
  clinicName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  slug: string | null;
  salesRepEmail: string | null;
  errors: ClinicFieldError[];
}

/** A cell that would run as a formula or carries control characters is not a name. */
const FORMULA_START = /^[=+\-@\t\r]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHONE_RE = /^\+?[0-9][0-9 ().-]{4,}$/;
const REGISTRATION_RE = /^[A-Za-z0-9][A-Za-z0-9 /._-]*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Deterministic slug from a clinic name: Latin letters/digits only, so an
 * Arabic-only name yields `''` and the row must supply `clinic_slug`. No numeric
 * suffix is ever appended — a suffix would make re-uploading the same file
 * mint a second clinic instead of reporting the first one.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMIT.slug)
    .replace(/-+$/g, '');
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const key = (v: string): string => v.trim().toLowerCase();

export function parseClinicRow(raw: RawClinicRow): ParsedClinicRow {
  const errors: ClinicFieldError[] = [];
  const err = (field: string, code: ClinicFieldCode) =>
    errors.push({ field, code });

  const text = (
    value: string | undefined,
    field: string,
    max: number,
    required: boolean,
  ): string | undefined => {
    if (value === undefined) {
      if (required) err(field, 'required');
      return undefined;
    }
    if (value.length > max) {
      err(field, 'too_long');
      return undefined;
    }
    if (FORMULA_START.test(value) || CONTROL_CHARS.test(value)) {
      err(field, 'invalid_text');
      return undefined;
    }
    return value;
  };

  const email = (
    value: string | undefined,
    field: string,
    required: boolean,
  ): string | undefined => {
    if (value === undefined) {
      if (required) err(field, 'required');
      return undefined;
    }
    const v = value.trim().toLowerCase();
    if (v.length > LIMIT.email) {
      err(field, 'too_long');
      return undefined;
    }
    if (!isEmail(v)) {
      err(field, 'invalid_email');
      return undefined;
    }
    return v;
  };

  const phone = (
    value: string | undefined,
    field: string,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (value.length > LIMIT.phone) {
      err(field, 'too_long');
      return undefined;
    }
    if (!PHONE_RE.test(value)) {
      err(field, 'invalid_phone');
      return undefined;
    }
    return value;
  };

  const clinicName = text(
    raw.clinicName,
    'clinic_name',
    LIMIT.clinicName,
    true,
  );
  const ownerName = text(raw.ownerName, 'owner_name', LIMIT.ownerName, true);
  const ownerEmail = email(raw.ownerEmail, 'owner_email', true);
  const clinicEmail = email(raw.clinicEmail, 'clinic_email', false);
  const salesRepEmail = email(raw.salesRepEmail, 'sales_rep_email', false);
  const ownerPhone = phone(raw.ownerPhone, 'owner_phone');
  const clinicPhone = phone(raw.clinicPhone, 'clinic_phone');
  const legalName = text(raw.legalName, 'legal_name', LIMIT.legalName, false);

  let commercialRegistration: string | undefined;
  if (raw.commercialRegistration === undefined) {
    err('commercial_registration_number', 'required');
  } else if (raw.commercialRegistration.length > LIMIT.commercialRegistration) {
    err('commercial_registration_number', 'too_long');
  } else if (!REGISTRATION_RE.test(raw.commercialRegistration)) {
    err('commercial_registration_number', 'invalid_registration');
  } else {
    commercialRegistration = raw.commercialRegistration;
  }

  let slug: string | undefined;
  if (raw.slug !== undefined) {
    const s = raw.slug.trim().toLowerCase();
    if (s.length > LIMIT.slug) err('clinic_slug', 'too_long');
    else if (!SLUG_RE.test(s)) err('clinic_slug', 'invalid_slug');
    else slug = s;
  } else if (clinicName) {
    slug = slugify(clinicName);
    if (!slug) err('clinic_slug', 'slug_not_derivable');
  }

  let currency: string | undefined;
  if (raw.currency !== undefined) {
    const c = raw.currency.trim().toUpperCase();
    if (CURRENCY_RE.test(c)) currency = c;
    else err('default_currency', 'invalid_currency');
  }

  let timezone: string | undefined;
  if (raw.timezone !== undefined) {
    if (isValidTimezone(raw.timezone.trim())) timezone = raw.timezone.trim();
    else err('default_timezone', 'invalid_timezone');
  }

  const display = {
    row: raw.row,
    clinicName: raw.clinicName ?? null,
    ownerName: raw.ownerName ?? null,
    ownerEmail: ownerEmail ?? raw.ownerEmail?.toLowerCase() ?? null,
    slug: slug ?? null,
    salesRepEmail: salesRepEmail ?? raw.salesRepEmail?.toLowerCase() ?? null,
  };
  if (
    errors.length > 0 ||
    !clinicName ||
    !ownerName ||
    !ownerEmail ||
    !commercialRegistration ||
    !slug
  ) {
    return { ...display, values: null, errors };
  }
  return {
    ...display,
    values: {
      clinicName,
      ownerName,
      ownerEmail,
      commercialRegistration,
      slug,
      ownerPhone,
      clinicEmail: clinicEmail ?? ownerEmail,
      clinicPhone: clinicPhone ?? ownerPhone,
      legalName,
      currency,
      timezone,
      salesRepEmail,
    },
    errors,
  };
}

/** What the database already holds, looked up in bulk for the whole file. */
export interface ClinicImportLookups {
  slugs: ReadonlySet<string>;
  /** `tenants.contact_email`, lower-cased. */
  clinicEmails: ReadonlySet<string>;
  /** Live `users.email`, lower-cased. */
  userEmails: ReadonlySet<string>;
  registrations: ReadonlySet<string>;
  /** Active `platform_sales` employees by lower-cased email. */
  reps: ReadonlyMap<string, { id: string; name: string | null }>;
}

export interface ClinicImportRow {
  row: number;
  status: ClinicImportRowStatus;
  clinicName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  slug: string | null;
  salesRepEmail: string | null;
  errors: ClinicFieldError[];
  /** Identifiers that already exist (`already_exists`). */
  conflicts: ClinicImportConflict[];
  /** First row of the file that carries the same identifier (`duplicate_in_file`). */
  duplicateOfRow: number | null;
}

export interface ClassifiedClinicRow extends ClinicImportRow {
  values: ClinicValues | null;
}

/**
 * One status per row. Order of precedence: invalid → duplicate in the file →
 * already in the database → unknown sales rep → will_create. In-file duplicates
 * keep the FIRST row and reject the later ones, so row order never changes
 * which clinic is created.
 */
export function classifyClinicRows(
  parsed: readonly ParsedClinicRow[],
  lookups: ClinicImportLookups,
): ClassifiedClinicRow[] {
  const seen = {
    slug: new Map<string, number>(),
    ownerEmail: new Map<string, number>(),
    clinicEmail: new Map<string, number>(),
    registration: new Map<string, number>(),
  };

  return parsed.map((p): ClassifiedClinicRow => {
    const base = {
      row: p.row,
      clinicName: p.clinicName,
      ownerName: p.ownerName,
      ownerEmail: p.ownerEmail,
      slug: p.slug,
      salesRepEmail: p.salesRepEmail,
      errors: p.errors,
      conflicts: [] as ClinicImportConflict[],
      duplicateOfRow: null as number | null,
      values: p.values,
    };
    const v = p.values;
    if (!v) return { ...base, status: 'invalid' };

    const keys = [
      [seen.slug, v.slug],
      [seen.ownerEmail, v.ownerEmail],
      [seen.clinicEmail, v.clinicEmail],
      [seen.registration, key(v.commercialRegistration)],
    ] as const;
    let firstRow: number | undefined;
    for (const [map, k] of keys) {
      const earlier = map.get(k);
      if (
        earlier !== undefined &&
        (firstRow === undefined || earlier < firstRow)
      ) {
        firstRow = earlier;
      }
    }
    if (firstRow !== undefined) {
      return { ...base, status: 'duplicate_in_file', duplicateOfRow: firstRow };
    }
    for (const [map, k] of keys) map.set(k, p.row);

    const conflicts: ClinicImportConflict[] = [];
    if (lookups.slugs.has(v.slug)) conflicts.push('slug');
    if (lookups.userEmails.has(v.ownerEmail)) conflicts.push('owner_email');
    if (lookups.clinicEmails.has(v.clinicEmail)) conflicts.push('clinic_email');
    if (lookups.registrations.has(key(v.commercialRegistration))) {
      conflicts.push('commercial_registration_number');
    }
    if (conflicts.length > 0)
      return { ...base, conflicts, status: 'already_exists' };

    if (v.salesRepEmail && !lookups.reps.has(v.salesRepEmail)) {
      return { ...base, status: 'sales_rep_not_found' };
    }
    return { ...base, status: 'will_create' };
  });
}

export function countClinicRows(
  rows: readonly { status: ClinicImportRowStatus }[],
  statuses: readonly ClinicImportRowStatus[],
): Record<ClinicImportRowStatus, number> {
  const counts = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<
    ClinicImportRowStatus,
    number
  >;
  for (const r of rows) counts[r.status] += 1;
  return counts;
}

/** The row as it is sent to the browser — never carries the normalised values object. */
export function toClinicImportRow(r: ClassifiedClinicRow): ClinicImportRow {
  const { values: _values, ...rest } = r;
  void _values;
  return rest;
}

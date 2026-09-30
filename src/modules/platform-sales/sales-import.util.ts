import type { SalesAssignmentKind } from '../../entities/Sales/SalesClinicAssignment';
import type { XlsxImportColumn } from '../../common/import/xlsx-row-parser';
import {
  SALES_IMPORT_NOTE_MAX,
  type SalesImportRowStatus,
  type SalesOnConflict,
} from './platform-sales.constants';

/**
 * Column header → row field. Header matching is case-insensitive; the first
 * alias is canonical (the template and the export both use it, so an export
 * can be edited and uploaded back). The clinic is identified by `clinic_slug`
 * (immutable, human-readable) or `clinic_id`; at least one must be present in a
 * ROW, but neither column is required in the FILE, so `required` is false here
 * and the per-row check reports `invalid_identifier`.
 */
export const SALES_IMPORT_COLUMNS: readonly XlsxImportColumn[] = [
  {
    field: 'slug',
    headers: ['clinic_slug', 'clinic slug', 'slug'],
    required: false,
  },
  { field: 'id', headers: ['clinic_id', 'clinic id'], required: false },
  { field: 'kind', headers: ['kind', 'assignment kind'], required: false },
  { field: 'note', headers: ['note', 'notes'], required: false },
] as const;

export interface RawImportRow {
  /** 1-based spreadsheet row (the header is row 1). */
  row: number;
  slug?: string;
  id?: string;
  kind?: string;
  note?: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,100}$/;

/** A row after cell-level validation; `error` is set when it can go no further. */
export interface ParsedImportRow {
  row: number;
  /** Lower-cased, trimmed. */
  slug: string | null;
  /** Lower-cased. */
  id: string | null;
  kind: SalesAssignmentKind;
  note: string | null;
  error: { status: SalesImportRowStatus; message: string } | null;
}

/** Cell-level validation only — nothing here looks at the database. */
export function parseImportRow(
  raw: RawImportRow,
  defaultKind: SalesAssignmentKind,
): ParsedImportRow {
  const slug = raw.slug?.trim().toLowerCase() || null;
  const id = raw.id?.trim().toLowerCase() || null;
  const kindText = raw.kind?.trim().toLowerCase();
  const note = raw.note?.trim() || null;

  const base = { row: raw.row, slug, id, note };
  const fail = (
    status: SalesImportRowStatus,
    message: string,
    kind: SalesAssignmentKind = defaultKind,
  ): ParsedImportRow => ({ ...base, kind, error: { status, message } });

  if (!slug && !id) {
    return fail('invalid_identifier', 'clinic_slug or clinic_id is required');
  }
  if (slug && !SLUG.test(slug)) {
    return fail(
      'invalid_identifier',
      'clinic_slug may only contain letters, digits and dashes',
    );
  }
  if (id && !UUID.test(id)) {
    return fail('invalid_identifier', 'clinic_id is not a valid UUID');
  }

  let kind = defaultKind;
  if (kindText) {
    if (kindText !== 'acquired' && kindText !== 'managed') {
      return fail('invalid_kind', 'kind must be "acquired" or "managed"');
    }
    kind = kindText;
  }
  if (note && note.length > SALES_IMPORT_NOTE_MAX) {
    return fail(
      'invalid_note',
      `note is longer than ${SALES_IMPORT_NOTE_MAX} characters`,
      kind,
    );
  }
  return { ...base, kind, error: null };
}

export interface ImportClinic {
  id: string;
  name: string;
  slug: string;
  approvalStatus: string;
}

export interface ImportOwner {
  employeeId: string;
  name: string | null;
}

/** Everything the classifier needs from the database, already loaded in bulk. */
export interface ImportLookups {
  /** Non-deleted clinics only, keyed by lower-cased slug / id. */
  bySlug: ReadonlyMap<string, ImportClinic>;
  byId: ReadonlyMap<string, ImportClinic>;
  /** Current active owner per clinic id. */
  activeOwner: ReadonlyMap<string, ImportOwner>;
  /** Clinic ids that already hold acquisition credit (ever, for anyone). */
  credited: ReadonlySet<string>;
}

export interface ClassifiedImportRow {
  row: number;
  status: SalesImportRowStatus;
  /** What the row asked for, for display: the slug, else the id. */
  identifier: string;
  /** The cells as given (trimmed, lower-cased) — so a failed-rows file can be fixed and re-uploaded. */
  slug: string | null;
  id: string | null;
  clinic: { id: string; name: string; slug: string } | null;
  kind: SalesAssignmentKind;
  note: string | null;
  /** The current owner, when another employee has the clinic. */
  owner: ImportOwner | null;
  /** English detail for API consumers and the failed-rows file; the UI translates `status`. */
  message: string | null;
}

/**
 * Decides what each row would do. Mirrors the order in which
 * `SalesAssignmentService.assignBatch` decides (already-mine → owned by other →
 * acquisition credit), so a `will_*` row is one the write will accept — and the
 * write, which re-checks under lock, stays the authority when state moves in
 * between.
 */
export function classifyImportRows(
  rows: readonly ParsedImportRow[],
  ctx: ImportLookups,
  opts: { employeeId: string; onConflict: SalesOnConflict },
): ClassifiedImportRow[] {
  const firstRowOfClinic = new Map<string, number>();

  return rows.map((p): ClassifiedImportRow => {
    const identifier = p.slug ?? p.id ?? '';
    const out = (
      status: SalesImportRowStatus,
      message: string | null,
      clinic: ImportClinic | null = null,
      owner: ImportOwner | null = null,
    ): ClassifiedImportRow => ({
      row: p.row,
      status,
      identifier,
      slug: p.slug,
      id: p.id,
      clinic: clinic
        ? { id: clinic.id, name: clinic.name, slug: clinic.slug }
        : null,
      kind: p.kind,
      note: p.note,
      owner,
      message,
    });

    if (p.error) return out(p.error.status, p.error.message);

    // 1. Resolve the clinic. Both columns given ⇒ they must agree.
    const bySlug = p.slug ? ctx.bySlug.get(p.slug) : undefined;
    const byId = p.id ? ctx.byId.get(p.id) : undefined;
    let clinic: ImportClinic | undefined;
    if (p.slug && p.id) {
      if (!bySlug && !byId) return out('not_found', 'No clinic matches');
      if (!bySlug || !byId || bySlug.id !== byId.id) {
        return out(
          'slug_id_mismatch',
          'clinic_slug and clinic_id point at different clinics',
        );
      }
      clinic = bySlug;
    } else {
      clinic = bySlug ?? byId;
      if (!clinic) return out('not_found', 'No clinic matches');
    }
    if (clinic.approvalStatus === 'REJECTED') {
      return out('clinic_rejected', 'The clinic was rejected', clinic);
    }

    // 2. First occurrence of a clinic wins; later ones are reported, not applied.
    const first = firstRowOfClinic.get(clinic.id);
    if (first !== undefined) {
      return out(
        'duplicate_in_file',
        `The clinic already appears on row ${first}`,
        clinic,
      );
    }
    firstRowOfClinic.set(clinic.id, p.row);

    // 3. Ownership.
    const owner = ctx.activeOwner.get(clinic.id) ?? null;
    if (owner?.employeeId === opts.employeeId) {
      return out('already_yours', null, clinic);
    }
    if (owner && opts.onConflict === 'skip') {
      return out(
        'assigned_to_other',
        'Another employee owns this clinic',
        clinic,
        owner,
      );
    }
    if (p.kind === 'acquired' && ctx.credited.has(clinic.id)) {
      return out(
        'acquisition_already_credited',
        'Acquisition credit was already granted for this clinic',
        clinic,
        owner,
      );
    }
    return owner
      ? out('will_reassign', null, clinic, owner)
      : out('will_assign', null, clinic);
  });
}

/** Row counts per status (every status present, zero included). */
export function countByStatus(
  rows: readonly { status: SalesImportRowStatus }[],
  statuses: readonly SalesImportRowStatus[],
): Record<SalesImportRowStatus, number> {
  const counts = Object.fromEntries(
    statuses.map((s) => [s, 0]),
  ) as Record<SalesImportRowStatus, number>;
  for (const r of rows) counts[r.status] += 1;
  return counts;
}

import { SALES_IMPORT_ROW_STATUS } from './platform-sales.constants';
import {
  ImportClinic,
  ImportLookups,
  classifyImportRows,
  countByStatus,
  parseImportRow,
} from './sales-import.util';

const EMP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const clinic = (n: number, approvalStatus = 'APPROVED'): ImportClinic => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`,
  name: `Clinic ${n}`,
  slug: `clinic-${n}`,
  approvalStatus,
});

function lookups(
  clinics: ImportClinic[],
  extra: Partial<Pick<ImportLookups, 'activeOwner' | 'credited'>> = {},
): ImportLookups {
  return {
    bySlug: new Map(clinics.map((c) => [c.slug, c])),
    byId: new Map(clinics.map((c) => [c.id, c])),
    activeOwner: extra.activeOwner ?? new Map(),
    credited: extra.credited ?? new Set(),
  };
}

const parse = (rows: Array<Record<string, string | undefined>>, kind: 'acquired' | 'managed' = 'managed') =>
  rows.map((r, i) => parseImportRow({ row: i + 2, ...r }, kind));

describe('parseImportRow', () => {
  it('needs a slug or an id', () => {
    const r = parseImportRow({ row: 2 }, 'managed');
    expect(r.error?.status).toBe('invalid_identifier');
  });

  it('lower-cases and trims the slug and the id', () => {
    const r = parseImportRow(
      { row: 2, slug: '  Clinic-1 ', id: '11111111-1111-4111-8111-11111111111A' },
      'managed',
    );
    expect(r.error).toBeNull();
    expect(r.slug).toBe('clinic-1');
    expect(r.id).toBe('11111111-1111-4111-8111-11111111111a');
  });

  it.each(['has space', 'under_score', 'a/b', 'x'.repeat(101), 'عيادة'])(
    'rejects the slug %j',
    (slug) => {
      expect(parseImportRow({ row: 2, slug }, 'managed').error?.status).toBe('invalid_identifier');
    },
  );

  it('rejects an id that is not a UUID', () => {
    expect(parseImportRow({ row: 2, id: '1234' }, 'managed').error?.status).toBe('invalid_identifier');
  });

  it('uses the default kind when the cell is blank, and accepts either kind in any case', () => {
    expect(parseImportRow({ row: 2, slug: 'a' }, 'acquired').kind).toBe('acquired');
    expect(parseImportRow({ row: 2, slug: 'a', kind: ' MANAGED ' }, 'acquired').kind).toBe('managed');
    expect(parseImportRow({ row: 2, slug: 'a', kind: 'Acquired' }, 'managed').kind).toBe('acquired');
  });

  it('rejects an unknown kind instead of silently defaulting', () => {
    const r = parseImportRow({ row: 2, slug: 'a', kind: 'owner' }, 'managed');
    expect(r.error?.status).toBe('invalid_kind');
  });

  it('trims the note, treats blank as none, and refuses one over 500 characters', () => {
    expect(parseImportRow({ row: 2, slug: 'a', note: '  hi ' }, 'managed').note).toBe('hi');
    expect(parseImportRow({ row: 2, slug: 'a', note: '   ' }, 'managed').note).toBeNull();
    expect(parseImportRow({ row: 2, slug: 'a', note: 'x'.repeat(500) }, 'managed').error).toBeNull();
    expect(parseImportRow({ row: 2, slug: 'a', note: 'x'.repeat(501) }, 'managed').error?.status).toBe(
      'invalid_note',
    );
  });
});

describe('classifyImportRows', () => {
  const c1 = clinic(1);
  const c2 = clinic(2);
  const c3 = clinic(3);
  const run = (
    rows: Array<Record<string, string | undefined>>,
    ctx: ImportLookups,
    onConflict: 'skip' | 'reassign' = 'skip',
    kind: 'acquired' | 'managed' = 'managed',
  ) => classifyImportRows(parse(rows, kind), ctx, { employeeId: EMP, onConflict });

  it('will_assign for a free clinic, resolved by slug or by id', () => {
    const out = run([{ slug: 'clinic-1' }, { id: c2.id }], lookups([c1, c2]));
    expect(out.map((r) => r.status)).toEqual(['will_assign', 'will_assign']);
    expect(out[0].clinic).toEqual({ id: c1.id, name: 'Clinic 1', slug: 'clinic-1' });
    expect(out[1].clinic?.slug).toBe('clinic-2');
  });

  it('already_yours when this employee owns it — a no-op, not an error', () => {
    const ctx = lookups([c1], { activeOwner: new Map([[c1.id, { employeeId: EMP, name: 'Me' }]]) });
    expect(run([{ slug: 'clinic-1' }], ctx)[0].status).toBe('already_yours');
  });

  it('assigned_to_other names the owner and is an error unless reassigning', () => {
    const ctx = lookups([c1], { activeOwner: new Map([[c1.id, { employeeId: OTHER, name: 'Omar' }]]) });
    const skip = run([{ slug: 'clinic-1' }], ctx, 'skip')[0];
    expect(skip.status).toBe('assigned_to_other');
    expect(skip.owner).toEqual({ employeeId: OTHER, name: 'Omar' });
    expect(run([{ slug: 'clinic-1' }], ctx, 'reassign')[0].status).toBe('will_reassign');
  });

  it('not_found for an unknown slug or id (deleted clinics are never loaded)', () => {
    const out = run([{ slug: 'nope' }, { id: '99999999-9999-4999-8999-999999999999' }], lookups([c1]));
    expect(out.map((r) => r.status)).toEqual(['not_found', 'not_found']);
    expect(out[0].clinic).toBeNull();
  });

  it('clinic_rejected for a REJECTED clinic', () => {
    const rejected = clinic(4, 'REJECTED');
    expect(run([{ slug: 'clinic-4' }], lookups([rejected]))[0].status).toBe('clinic_rejected');
  });

  describe('slug + id together', () => {
    it('agree → resolves', () => {
      expect(run([{ slug: 'clinic-1', id: c1.id }], lookups([c1, c2]))[0].status).toBe('will_assign');
    });
    it('point at different clinics → slug_id_mismatch', () => {
      expect(run([{ slug: 'clinic-1', id: c2.id }], lookups([c1, c2]))[0].status).toBe('slug_id_mismatch');
    });
    it('one of them unknown → slug_id_mismatch (not a silent partial match)', () => {
      const ghost = '99999999-9999-4999-8999-999999999999';
      expect(run([{ slug: 'clinic-1', id: ghost }], lookups([c1]))[0].status).toBe('slug_id_mismatch');
      expect(run([{ slug: 'ghost', id: c1.id }], lookups([c1]))[0].status).toBe('slug_id_mismatch');
    });
    it('both unknown → not_found', () => {
      const ghost = '99999999-9999-4999-8999-999999999999';
      expect(run([{ slug: 'ghost', id: ghost }], lookups([c1]))[0].status).toBe('not_found');
    });
  });

  describe('duplicate_in_file', () => {
    it('first occurrence wins; later ones (even via the other identifier) are reported', () => {
      const out = run(
        [{ slug: 'clinic-1' }, { slug: 'clinic-1' }, { id: c1.id }, { slug: 'clinic-2' }],
        lookups([c1, c2]),
      );
      expect(out.map((r) => r.status)).toEqual(['will_assign', 'duplicate_in_file', 'duplicate_in_file', 'will_assign']);
      expect(out[1].message).toContain('row 2');
    });

    it('a duplicate of an already_yours row is still a duplicate', () => {
      const ctx = lookups([c1], { activeOwner: new Map([[c1.id, { employeeId: EMP, name: 'Me' }]]) });
      expect(run([{ slug: 'clinic-1' }, { slug: 'clinic-1' }], ctx).map((r) => r.status)).toEqual([
        'already_yours',
        'duplicate_in_file',
      ]);
    });

    it('does not consume a clinic on a row that failed validation earlier', () => {
      const out = run([{ slug: 'clinic-1', kind: 'boss' }, { slug: 'clinic-1' }], lookups([c1]));
      expect(out.map((r) => r.status)).toEqual(['invalid_kind', 'will_assign']);
    });
  });

  describe('acquisition credit (once per clinic, ever)', () => {
    const credited = lookups([c1, c2], { credited: new Set([c1.id]) });

    it('blocks an ACQUIRED row for an already-credited clinic', () => {
      expect(run([{ slug: 'clinic-1', kind: 'acquired' }], credited)[0].status).toBe(
        'acquisition_already_credited',
      );
    });
    it('does not block a MANAGED row for the same clinic', () => {
      expect(run([{ slug: 'clinic-1', kind: 'managed' }], credited)[0].status).toBe('will_assign');
    });
    it('applies to rows that inherit an acquired default too', () => {
      expect(run([{ slug: 'clinic-1' }], credited, 'skip', 'acquired')[0].status).toBe(
        'acquisition_already_credited',
      );
    });
    it('an uncredited clinic can be acquired', () => {
      expect(run([{ slug: 'clinic-2', kind: 'acquired' }], credited)[0].status).toBe('will_assign');
    });
    it('is decided AFTER ownership, like the write: skip-mode ownership by another wins', () => {
      const ctx = lookups([c1], {
        credited: new Set([c1.id]),
        activeOwner: new Map([[c1.id, { employeeId: OTHER, name: 'Omar' }]]),
      });
      expect(run([{ slug: 'clinic-1', kind: 'acquired' }], ctx, 'skip')[0].status).toBe('assigned_to_other');
      expect(run([{ slug: 'clinic-1', kind: 'acquired' }], ctx, 'reassign')[0].status).toBe(
        'acquisition_already_credited',
      );
    });
  });

  it('keeps validation errors from parseImportRow and echoes what the row asked for', () => {
    const out = run([{ slug: 'Bad Slug' }, {}], lookups([c1]));
    expect(out.map((r) => r.status)).toEqual(['invalid_identifier', 'invalid_identifier']);
    expect(out[0].identifier).toBe('bad slug');
    expect(out[0]).toMatchObject({ slug: 'bad slug', id: null });
    expect(out.map((r) => r.row)).toEqual([2, 3]);
  });

  it('carries kind and note through to applicable rows', () => {
    const out = run([{ slug: 'clinic-3', kind: 'acquired', note: 'brought in' }], lookups([c3]));
    expect(out[0]).toMatchObject({ status: 'will_assign', kind: 'acquired', note: 'brought in' });
  });
});

describe('countByStatus', () => {
  it('reports every status, zero included', () => {
    const counts = countByStatus(
      [{ status: 'will_assign' }, { status: 'will_assign' }, { status: 'not_found' }],
      SALES_IMPORT_ROW_STATUS,
    );
    expect(Object.keys(counts).sort()).toEqual([...SALES_IMPORT_ROW_STATUS].sort());
    expect(counts.will_assign).toBe(2);
    expect(counts.not_found).toBe(1);
    expect(counts.duplicate_in_file).toBe(0);
  });
});

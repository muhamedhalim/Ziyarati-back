import {
  ClinicImportLookups,
  RawClinicRow,
  classifyClinicRows,
  parseClinicRow,
  slugify,
} from './clinic-import.util';

const base = (over: Partial<RawClinicRow> = {}): RawClinicRow => ({
  row: 2,
  clinicName: 'Al Noor Clinic',
  ownerName: 'Dr Ahmed',
  ownerEmail: 'Owner@AlNoor.test',
  commercialRegistration: 'CR-1010',
  ...over,
});

const empty: ClinicImportLookups = {
  slugs: new Set(),
  clinicEmails: new Set(),
  userEmails: new Set(),
  registrations: new Set(),
  reps: new Map(),
};
const codes = (r: RawClinicRow) =>
  parseClinicRow(r).errors.map((e) => `${e.field}:${e.code}`);

describe('slugify', () => {
  it('is deterministic and never appends a suffix', () => {
    expect(slugify('Al-Noor  Clinic & Co.')).toBe('al-noor-clinic-co');
    expect(slugify('Al-Noor  Clinic & Co.')).toBe(
      slugify('Al-Noor  Clinic & Co.'),
    );
  });
  it('strips diacritics and yields empty for a name without Latin letters', () => {
    expect(slugify('Clínica Ñandú')).toBe('clinica-nandu');
    expect(slugify('عيادة النور')).toBe('');
  });
  it('caps at 100 chars without a trailing dash', () => {
    const s = slugify(`${'a'.repeat(99)} b`);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith('-')).toBe(false);
  });
});

describe('parseClinicRow', () => {
  it('normalises a valid row (email lower-cased, slug derived, contact defaults to owner)', () => {
    const p = parseClinicRow(base({ ownerPhone: '+966 50 123 4567' }));
    expect(p.errors).toEqual([]);
    expect(p.values).toMatchObject({
      ownerEmail: 'owner@alnoor.test',
      clinicEmail: 'owner@alnoor.test',
      slug: 'al-noor-clinic',
      clinicPhone: '+966 50 123 4567',
    });
  });

  it('flags every missing required field by column header', () => {
    expect(codes({ row: 2 })).toEqual(
      expect.arrayContaining([
        'clinic_name:required',
        'owner_name:required',
        'owner_email:required',
        'commercial_registration_number:required',
      ]),
    );
  });

  it.each([
    [{ ownerEmail: 'not-an-email' }, 'owner_email:invalid_email'],
    [{ clinicEmail: 'a@' }, 'clinic_email:invalid_email'],
    [{ salesRepEmail: 'x' }, 'sales_rep_email:invalid_email'],
    [{ ownerPhone: 'call me' }, 'owner_phone:invalid_phone'],
    [{ ownerPhone: '1'.repeat(21) }, 'owner_phone:too_long'],
    [{ slug: 'Bad Slug!' }, 'clinic_slug:invalid_slug'],
    [{ clinicName: 'x'.repeat(101) }, 'clinic_name:too_long'],
    [
      { commercialRegistration: 'CR;DROP' },
      'commercial_registration_number:invalid_registration',
    ],
    [{ currency: 'SARR' }, 'default_currency:invalid_currency'],
    [{ timezone: 'Mars/Base' }, 'default_timezone:invalid_timezone'],
    [{ clinicName: '=HYPERLINK("http://x")' }, 'clinic_name:invalid_text'],
    [{ ownerName: '@cmd' }, 'owner_name:invalid_text'],
    [{ legalName: '+1+1' }, 'legal_name:invalid_text'],
    [{ clinicName: 'Bad\u0000Name' }, 'clinic_name:invalid_text'],
  ] as Array<[Partial<RawClinicRow>, string]>)(
    'rejects %j with %s',
    (over, code) => {
      expect(codes(base(over))).toContain(code);
      expect(parseClinicRow(base(over)).values).toBeNull();
    },
  );

  it('asks for an explicit slug when the name cannot yield one', () => {
    expect(codes(base({ clinicName: 'عيادة النور' }))).toContain(
      'clinic_slug:slug_not_derivable',
    );
    expect(
      parseClinicRow(base({ clinicName: 'عيادة النور', slug: 'al-noor' }))
        .errors,
    ).toEqual([]);
  });

  it('upper-cases currency and accepts a real IANA zone', () => {
    const p = parseClinicRow(
      base({ currency: ' sar ', timezone: 'Asia/Riyadh' }),
    );
    expect(p.values).toMatchObject({
      currency: 'SAR',
      timezone: 'Asia/Riyadh',
    });
  });
});

describe('classifyClinicRows', () => {
  const classify = (rows: RawClinicRow[], lookups = empty) =>
    classifyClinicRows(rows.map(parseClinicRow), lookups);

  it('marks a clean row will_create', () => {
    expect(classify([base()])[0].status).toBe('will_create');
  });

  it('keeps the FIRST of two rows sharing an identifier, whatever it is', () => {
    const rows = classify([
      base({ row: 2 }),
      base({
        row: 3,
        clinicName: 'Other',
        ownerEmail: 'o2@x.test',
        commercialRegistration: 'CR-2',
        slug: 'al-noor-clinic',
      }), // slug
      base({
        row: 4,
        clinicName: 'Third',
        ownerEmail: 'OWNER@alnoor.test',
        commercialRegistration: 'CR-3',
      }), // owner email
      base({
        row: 5,
        clinicName: 'Fourth',
        ownerEmail: 'o4@x.test',
        commercialRegistration: 'cr-1010',
      }), // CR, case-insensitive
      base({
        row: 6,
        clinicName: 'Fifth',
        ownerEmail: 'o5@x.test',
        commercialRegistration: 'CR-5',
        clinicEmail: 'owner@alnoor.test',
      }), // clinic email
    ]);
    expect(rows.map((r) => r.status)).toEqual([
      'will_create',
      'duplicate_in_file',
      'duplicate_in_file',
      'duplicate_in_file',
      'duplicate_in_file',
    ]);
    expect(rows.slice(1).every((r) => r.duplicateOfRow === 2)).toBe(true);
  });

  it('does not let an invalid row claim an identifier', () => {
    const rows = classify([
      base({ row: 2, ownerPhone: 'bad' }), // invalid
      base({ row: 3 }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['invalid', 'will_create']);
  });

  it('reports every colliding identifier of an existing clinic and never creates', () => {
    const [r] = classify([base()], {
      ...empty,
      slugs: new Set(['al-noor-clinic']),
      userEmails: new Set(['owner@alnoor.test']),
      clinicEmails: new Set(['owner@alnoor.test']),
      registrations: new Set(['cr-1010']),
    });
    expect(r.status).toBe('already_exists');
    expect(r.conflicts).toEqual([
      'slug',
      'owner_email',
      'clinic_email',
      'commercial_registration_number',
    ]);
  });

  it('flags a sales rep that is not an active sales employee', () => {
    const rows = classify([base({ salesRepEmail: 'rep@x.test' })]);
    expect(rows[0].status).toBe('sales_rep_not_found');
    const ok = classify([base({ salesRepEmail: 'rep@x.test' })], {
      ...empty,
      reps: new Map([['rep@x.test', { id: 'u1', name: 'Rep' }]]),
    });
    expect(ok[0].status).toBe('will_create');
  });
});

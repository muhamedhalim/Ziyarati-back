import { deflateRawSync } from 'node:zlib';

import { AppError, ErrorCode } from '../errors';
import { loadExcelJs, parseXlsxRows } from './xlsx-row-parser';
import {
  assertZipInflationBounded,
  ZipInflationError,
} from './zip-inflation-bound';
import {
  CUSTOMER_IMPORT_COLUMNS,
  CUSTOMER_IMPORT_MAX_BYTES,
  CUSTOMER_IMPORT_MAX_ROWS,
  CUSTOMER_IMPORT_SCAN_ROW_CEILING,
  CUSTOMER_IMPORT_UPLOAD_POLICY,
} from '../../modules/crm/customer-import.constants';

/**
 * RL-06. Archives are built in-test with a minimal zip writer so each case
 * controls exactly what the central directory DECLARES versus what the entry
 * REALLY inflates to. All payloads are small (≤ 2 MB inflated).
 */
interface TestEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Override the declared uncompressed size (to lie about it). */
  declaredSize?: number;
}

function zip(
  entries: TestEntry[],
  opts: { totalEntriesOverride?: number } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const declared = e.declaredSize ?? e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = opts.totalEntriesOverride ?? entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const MB = 1024 * 1024;
const limits = { maxUncompressedBytes: 1 * MB, maxEntries: 10 };
const reasonOf = (fn: () => void) => {
  try {
    fn();
    return 'passed';
  } catch (e) {
    return e instanceof ZipInflationError
      ? e.reason
      : `other: ${(e as Error).message}`;
  }
};

describe('assertZipInflationBounded (RL-06)', () => {
  it('accepts a small archive within both limits', () => {
    const buf = zip([{ name: 'a.xml', data: Buffer.alloc(100 * 1024, 'a') }]);
    expect(reasonOf(() => assertZipInflationBounded(buf, limits))).toBe(
      'passed',
    );
  });

  it('refuses an archive whose DECLARED sizes exceed the budget, without inflating it', () => {
    const buf = zip([{ name: 'a.xml', data: Buffer.alloc(2 * MB) }]);
    expect(reasonOf(() => assertZipInflationBounded(buf, limits))).toBe(
      'too_large',
    );
  });

  it('refuses an archive that UNDER-declares its size — the real inflation is cut off at the budget', () => {
    const buf = zip([
      { name: 'a.xml', data: Buffer.alloc(2 * MB), declaredSize: 10 },
    ]);
    expect(buf.length).toBeLessThan(10 * 1024); // tiny upload, large inflation
    expect(reasonOf(() => assertZipInflationBounded(buf, limits))).toBe(
      'too_large',
    );
  });

  it('sums entries: several under-declared parts that together exceed the budget are refused', () => {
    const part = (n: number) => ({
      name: `p${n}.xml`,
      data: Buffer.alloc(400 * 1024),
      declaredSize: 1,
    });
    const buf = zip([part(1), part(2), part(3)]);
    expect(reasonOf(() => assertZipInflationBounded(buf, limits))).toBe(
      'too_large',
    );
  });

  it('counts STORED entries at their real size', () => {
    const buf = zip([
      {
        name: 'img.png',
        data: Buffer.alloc(2 * MB),
        method: 0,
        declaredSize: 1,
      },
    ]);
    expect(reasonOf(() => assertZipInflationBounded(buf, limits))).toBe(
      'too_large',
    );
  });

  it('refuses too many entries', () => {
    const buf = zip(
      Array.from({ length: 11 }, (_, i) => ({
        name: `e${i}`,
        data: Buffer.from('x'),
      })),
    );
    expect(reasonOf(() => assertZipInflationBounded(buf, limits))).toBe(
      'too_many_entries',
    );
  });

  it('refuses the ZIP64 marker', () => {
    const buf = zip([{ name: 'a', data: Buffer.from('x') }], {
      totalEntriesOverride: 0xffff,
    });
    expect(
      reasonOf(() =>
        assertZipInflationBounded(buf, { ...limits, maxEntries: 0xffff }),
      ),
    ).toBe('unsupported');
  });

  it('refuses something that is not a zip at all', () => {
    expect(
      reasonOf(() =>
        assertZipInflationBounded(Buffer.from('PK not really'), limits),
      ),
    ).toBe('not_a_zip');
    expect(
      reasonOf(() => assertZipInflationBounded(Buffer.alloc(0), limits)),
    ).toBe('not_a_zip');
  });
});

describe('parseXlsxRows applies the inflation bound before exceljs (RL-06)', () => {
  const XLSX_MIME =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const opts = {
    policy: CUSTOMER_IMPORT_UPLOAD_POLICY,
    columns: CUSTOMER_IMPORT_COLUMNS,
    maxBytes: CUSTOMER_IMPORT_MAX_BYTES,
    maxRows: CUSTOMER_IMPORT_MAX_ROWS,
    scanRowCeiling: CUSTOMER_IMPORT_SCAN_ROW_CEILING,
  };
  const asUpload = (buffer: Buffer) => ({
    originalname: 'customers.xlsx',
    mimetype: XLSX_MIME,
    size: buffer.length,
    buffer,
  });

  async function realWorkbook(): Promise<Buffer> {
    const ExcelJS = loadExcelJs();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.addRow(CUSTOMER_IMPORT_COLUMNS.map((c) => c.headers[0]));
    ws.addRow(CUSTOMER_IMPORT_COLUMNS.map(() => 'x'));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('a normal workbook still parses under the default bound', async () => {
    const parsed = await parseXlsxRows(asUpload(await realWorkbook()), opts);
    expect(parsed.dataRows).toHaveLength(1);
  });

  it('a workbook that inflates past the bound is refused with FILE_TOO_LARGE before parsing', async () => {
    const buf = await realWorkbook();
    const err = await parseXlsxRows(asUpload(buf), {
      ...opts,
      maxUncompressedBytes: 1024,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.FILE_TOO_LARGE);
  });
});

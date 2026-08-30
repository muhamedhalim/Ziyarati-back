import ExcelJS from 'exceljs';

import { XlsxWriterService } from './xlsx-writer.service';
import { ExportColumn } from './export-registry';

const COLUMNS: ExportColumn[] = [
  { key: 'a', header: 'Column A' },
  { key: 'b', header: 'Column B' },
];

describe('XlsxWriterService (T182)', () => {
  const writer = new XlsxWriterService();

  it('T186 — an empty result set still produces a well-formed file with headers and zero data rows', async () => {
    const { buffer, rowCount } = await writer.writeToBuffer(
      COLUMNS,
      async () => ({
        rows: [],
        nextCursor: null,
      }),
    );

    expect(rowCount).toBe(0);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).getCell(1).text).toBe('Column A');
    expect(sheet.getRow(1).getCell(2).text).toBe('Column B');
    // Only the header row — no data rows.
    expect(sheet.rowCount).toBe(1);
  });

  it('streams multiple keyset pages, writing every row and stopping at the last (short) page', async () => {
    const allRows = Array.from({ length: 25 }, (_, i) => ({
      a: `row-${i}`,
      b: i,
    }));
    const pageSize = 10;
    const cursorsSeen: (string | null)[] = [];

    const { buffer, rowCount } = await writer.writeToBuffer(
      COLUMNS,
      async (cursor, size) => {
        cursorsSeen.push(cursor);
        expect(size).toBe(pageSize);
        const start = cursor ? Number(cursor) : 0;
        const rows = allRows.slice(start, start + size);
        const nextCursor = rows.length === size ? String(start + size) : null;
        return { rows, nextCursor };
      },
      pageSize,
    );

    expect(rowCount).toBe(25);
    // 3 pages: cursor null, '10', '20'.
    expect(cursorsSeen).toEqual([null, '10', '20']);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    // header + 25 data rows
    expect(sheet.rowCount).toBe(26);
    expect(sheet.getRow(2).getCell(1).text).toBe('row-0');
    expect(sheet.getRow(26).getCell(1).text).toBe('row-24');
  });

  it('stops immediately when the first page is short, without requesting a next page', async () => {
    const fetchPage = jest.fn().mockResolvedValueOnce({
      rows: [{ a: 'only', b: 1 }],
      nextCursor: null,
    });

    const { rowCount } = await writer.writeToBuffer(COLUMNS, fetchPage, 500);

    expect(rowCount).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

import { Injectable } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import type ExcelJSType from 'exceljs';

import { escapeSpreadsheetRow } from '../../common/import/spreadsheet-escape';
import { ExportColumn } from './export-registry';

/** One page of rows plus the cursor to resume from (`null` = no more pages). */
export interface ExportPage {
  rows: readonly Record<string, unknown>[];
  nextCursor: string | null;
}

export type FetchExportPage = (
  cursor: string | null,
  pageSize: number,
) => Promise<ExportPage>;

/** Rows are fetched and written a page at a time — never more than one page in memory. */
export const DEFAULT_XLSX_PAGE_SIZE = 500;

/**
 * Spec 014 (Clinic Platform Completion) — T182 (US13, FR-X008).
 *
 * Streams rows into an XLSX workbook using `exceljs`'s streaming
 * `WorkbookWriter` over a KEYSET-paginated source (`fetchPage`): each call
 * asks for the NEXT page after a cursor, writes and commits that page's
 * rows one at a time, then discards them before asking for the next page.
 * Peak memory is therefore bounded to one page's worth of rows regardless
 * of how many rows the export has in total — a 100-row and a 100 000-row
 * export hold the same amount of row data in memory at any instant.
 *
 * Headers are written from `columns` unconditionally, even when the very
 * first page comes back empty (T186, FR-X013) — the workbook always has a
 * valid header row, so an empty export opens cleanly in a spreadsheet
 * application instead of erroring or producing a corrupt/empty file.
 *
 * `exceljs` is required LAZILY (mirrors `CustomerImportService.loadExcelJs`
 * exactly) so the worker boot path — which registers this provider but does
 * not necessarily run an export on every process — never pays for loading
 * the library until an export actually runs.
 */
@Injectable()
export class XlsxWriterService {
  /**
   * Streams `fetchPage` into a single in-memory Buffer (the shape
   * `StorageService.upload` and the synchronous 200-response path both
   * need). The BUFFER is the compact, compressed XLSX file — typically a
   * small fraction of the raw row data's size — never the uncompressed row
   * set; what stays bounded per FR-X008 is the ROW data held at any instant
   * while writing, which is exactly one page.
   */
  async writeToBuffer(
    columns: readonly ExportColumn[],
    fetchPage: FetchExportPage,
    pageSize: number = DEFAULT_XLSX_PAGE_SIZE,
  ): Promise<{ buffer: Buffer; rowCount: number }> {
    const ExcelJS = this.loadExcelJs();
    const passthrough = new PassThrough();
    const chunks: Buffer[] = [];
    passthrough.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      passthrough.on('end', resolve);
      passthrough.on('error', reject);
    });

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: passthrough,
      useStyles: false,
      useSharedStrings: false,
    });
    const sheet = workbook.addWorksheet('Export');
    sheet.columns = columns.map((c) => ({ header: c.header, key: c.key }));

    let rowCount = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await fetchPage(cursor, pageSize);
      for (const row of page.rows) {
        // SEC-05: text starting = + - @ would run as a formula when staff open
        // the export. Escaped here, at the boundary — stored data is unchanged.
        sheet.addRow(escapeSpreadsheetRow(row)).commit();
        rowCount++;
      }
      if (!page.nextCursor || page.rows.length === 0) break;
      cursor = page.nextCursor;
    }

    sheet.commit();
    await workbook.commit();
    passthrough.end();
    await done;

    return { buffer: Buffer.concat(chunks), rowCount };
  }

  /**
   * `exceljs` is required lazily so the boot path and the queue worker
   * process pay for loading it only when an export actually runs — mirrors
   * `CustomerImportService.loadExcelJs`'s identical pattern.
   */
  private loadExcelJs(): typeof ExcelJSType {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('exceljs') as typeof ExcelJSType;
  }
}

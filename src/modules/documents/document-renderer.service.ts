import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import PDFDocument from 'pdfkit';

import { DocumentBlock, DocumentTemplate } from './document-blocks';
import { layoutBidiText } from './bidi-text-layout';

const PAGE_MARGIN = 50;
const CONTENT_WIDTH = 495; // A4 (595pt) minus both margins
const LINE_HEIGHT = 22;

const FONT_DIR = path.join(__dirname, 'fonts');
const ARABIC_FONT_PATH = path.join(FONT_DIR, 'NotoNaskhArabic-Arabic-400.woff');
const LATIN_FONT_PATH = path.join(FONT_DIR, 'NotoNaskhArabic-Latin-400.woff');

/**
 * Spec 014 (Clinic Platform Completion) — T021 (S4/S12/S13). The ONE PDF
 * rendering seam, shared by the invoice document (T091+) and report export
 * (T178+). Per contracts/internal-seams.md §7 and research.md O-1 (the T001
 * spike's findings, which this implementation follows exactly).
 *
 * WORKER ROLE ONLY: throws if constructed anywhere `PROCESS_ROLE` is not
 * `'worker'` (set by `worker.ts`, never by `main.ts`/`migrate.ts`) — PDF
 * generation is unbounded CPU work and must never run on a request path
 * (R2, FR-I013).
 *
 * Templates receive pre-sanitised, already-authorized data (`data:
 * unknown`) — this service performs no data access, no authorization
 * check, and no domain interpretation of its own. It only lays out the
 * `DocumentBlock[]` a template produces.
 */
@Injectable()
export class DocumentRendererService {
  constructor() {
    if (process.env.PROCESS_ROLE !== 'worker') {
      throw new Error(
        'DocumentRendererService may only be constructed in the worker process ' +
          '(PROCESS_ROLE=worker) — PDF rendering must never run on an API request path. ' +
          'See research.md R2.',
      );
    }
  }

  async render(
    template: DocumentTemplate,
    data: unknown,
    locale: 'ar' | 'en',
  ): Promise<Buffer> {
    const blocks = template.toBlocks(data, locale);
    const rtl = locale === 'ar';

    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
    doc.registerFont('arabic', ARABIC_FONT_PATH);
    doc.registerFont('latin', LATIN_FONT_PATH);
    doc.font(rtl ? 'arabic' : 'latin').fontSize(11);

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    let y = PAGE_MARGIN;
    const ensureRoom = (needed: number) => {
      if (y + needed > doc.page.height - PAGE_MARGIN) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
    };

    for (const block of blocks) {
      y = this.renderBlock(doc, block, y, rtl, ensureRoom);
    }

    doc.end();
    return done;
  }

  private renderBlock(
    doc: PDFKit.PDFDocument,
    block: DocumentBlock,
    y: number,
    rtl: boolean,
    ensureRoom: (needed: number) => void,
  ): number {
    switch (block.type) {
      case 'spacer':
        return y + LINE_HEIGHT / 2;

      case 'heading': {
        ensureRoom(LINE_HEIGHT * 1.5);
        doc.fontSize(15);
        this.drawLine(doc, block.text, y, rtl);
        doc.fontSize(11);
        return y + LINE_HEIGHT * 1.5;
      }

      case 'text': {
        ensureRoom(LINE_HEIGHT);
        this.drawLine(doc, block.text, y, rtl);
        return y + LINE_HEIGHT;
      }

      case 'keyValue': {
        let cursor = y;
        for (const row of block.rows) {
          ensureRoom(LINE_HEIGHT);
          this.drawLine(doc, `${row.label}: ${row.value}`, cursor, rtl);
          cursor += LINE_HEIGHT;
        }
        return cursor;
      }

      case 'table': {
        let cursor = y;
        const columns = block.headers.length || 1;
        const colWidth = CONTENT_WIDTH / columns;
        const rows = [block.headers, ...block.rows];
        for (const row of rows) {
          ensureRoom(LINE_HEIGHT);
          // A table row's columns are drawn right-to-left for `ar` (mirrors
          // the physical page layout a reader expects), left-to-right for
          // `en` — the CONTENT of each individual cell still goes through
          // the same bidi text layout either way, since a cell can itself
          // mix scripts (e.g. an Arabic service name, a Latin price).
          const cells = rtl ? [...row].reverse() : row;
          cells.forEach((cell, i) => {
            const cellX = PAGE_MARGIN + i * colWidth;
            this.drawCell(doc, cell, cellX, cursor, colWidth, rtl);
          });
          cursor += LINE_HEIGHT;
        }
        return cursor;
      }

      default:
        return y;
    }
  }

  /** A full-width line, right-aligned RTL (bidi-laid-out) or left-aligned LTR. */
  private drawLine(doc: PDFKit.PDFDocument, text: string, y: number, rtl: boolean): void {
    if (!rtl) {
      doc.font('latin').text(text, PAGE_MARGIN, y, { width: CONTENT_WIDTH, align: 'left' });
      return;
    }
    const segments = layoutBidiText(text);
    let totalWidth = 0;
    for (const seg of segments) totalWidth += doc.font(seg.font).widthOfString(seg.text);
    let x = PAGE_MARGIN + CONTENT_WIDTH - totalWidth;
    for (const seg of segments) {
      doc.font(seg.font).text(seg.text, x, y, { lineBreak: false, features: ['rtla'] });
      x += doc.font(seg.font).widthOfString(seg.text);
    }
  }

  /** A single table cell within a fixed column width. */
  private drawCell(
    doc: PDFKit.PDFDocument,
    text: string,
    x: number,
    y: number,
    width: number,
    rtl: boolean,
  ): void {
    if (!rtl) {
      doc.font('latin').text(text, x, y, { width, align: 'left' });
      return;
    }
    const segments = layoutBidiText(text);
    let totalWidth = 0;
    for (const seg of segments) totalWidth += doc.font(seg.font).widthOfString(seg.text);
    let cursorX = x + Math.max(0, width - totalWidth);
    for (const seg of segments) {
      doc.font(seg.font).text(seg.text, cursorX, y, { lineBreak: false, features: ['rtla'] });
      cursorX += doc.font(seg.font).widthOfString(seg.text);
    }
  }
}

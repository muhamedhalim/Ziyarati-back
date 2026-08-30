import { DocumentRendererService } from './document-renderer.service';
import { DocumentTemplate, DocumentBlock } from './document-blocks';

const withWorkerRole = <T>(fn: () => T): T => {
  const prev = process.env.PROCESS_ROLE;
  process.env.PROCESS_ROLE = 'worker';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = prev;
  }
};

const template = (blocks: DocumentBlock[]): DocumentTemplate => ({
  toBlocks: () => blocks,
});

describe('DocumentRendererService', () => {
  const prevRole = process.env.PROCESS_ROLE;
  afterEach(() => {
    if (prevRole === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = prevRole;
  });

  it('refuses to construct outside the worker role', () => {
    delete process.env.PROCESS_ROLE;
    expect(() => new DocumentRendererService()).toThrow(/worker process/);

    process.env.PROCESS_ROLE = 'api';
    expect(() => new DocumentRendererService()).toThrow(/worker process/);
  });

  it('constructs successfully when PROCESS_ROLE=worker', () => {
    withWorkerRole(() => {
      expect(() => new DocumentRendererService()).not.toThrow();
    });
  });

  it('renders a valid PDF for English content', async () => {
    const buffer = await withWorkerRole(() => {
      const svc = new DocumentRendererService();
      return svc.render(
        template([
          { type: 'heading', text: 'Invoice' },
          { type: 'text', text: 'Thank you for your visit.' },
          { type: 'keyValue', rows: [{ label: 'Total', value: '350.00 SAR' }] },
          { type: 'table', headers: ['Service', 'Price'], rows: [['Consult', '100.00']] },
        ]),
        {},
        'en',
      );
    });
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(100);
  });

  it('renders a valid PDF for Arabic content (bidi layout)', async () => {
    const buffer = await withWorkerRole(() => {
      const svc = new DocumentRendererService();
      return svc.render(
        template([
          { type: 'heading', text: 'فاتورة ضريبية' },
          { type: 'text', text: 'رقم الفاتورة INV-2026-00142 والمبلغ 350.00 SAR' },
        ]),
        {},
        'ar',
      );
    });
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('paginates across a page boundary rather than overflowing silently', async () => {
    const manyLines: DocumentBlock[] = Array.from({ length: 80 }, (_, i) => ({
      type: 'text' as const,
      text: `Line ${i}`,
    }));
    const buffer = await withWorkerRole(() => {
      const svc = new DocumentRendererService();
      return svc.render(template(manyLines), {}, 'en');
    });
    // A real multi-page PDF has more than one `/Type /Page` object.
    const pageCount = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
  });

  it('calls the template with the requested data and locale', async () => {
    const toBlocks = jest.fn().mockReturnValue([{ type: 'text', text: 'x' }]);
    await withWorkerRole(() => {
      const svc = new DocumentRendererService();
      return svc.render({ toBlocks }, { invoiceId: 'i1' }, 'ar');
    });
    expect(toBlocks).toHaveBeenCalledWith({ invoiceId: 'i1' }, 'ar');
  });
});

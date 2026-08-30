import { InvoiceDocumentTracking1730075000000 } from './1730075000000-InvoiceDocumentTracking';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query } as never);
  return query.mock.calls.map(([statement]) => statement as string);
};

describe('InvoiceDocumentTracking migration', () => {
  it('adds the three document-tracking columns', async () => {
    const statements = await sqlOf((q) =>
      new InvoiceDocumentTracking1730075000000().up(q as never),
    );
    expect(statements[0]).toContain('ADD COLUMN IF NOT EXISTS "document_key"');
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "document_version" integer NOT NULL DEFAULT 0',
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "document_rendered_version"',
    );
  });

  it('down drops all three columns', async () => {
    const statements = await sqlOf((q) =>
      new InvoiceDocumentTracking1730075000000().down(q as never),
    );
    expect(statements[0]).toContain('DROP COLUMN IF EXISTS "document_key"');
    expect(statements[0]).toContain('DROP COLUMN IF EXISTS "document_version"');
    expect(statements[0]).toContain(
      'DROP COLUMN IF EXISTS "document_rendered_version"',
    );
  });
});

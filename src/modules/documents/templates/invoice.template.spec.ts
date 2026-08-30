import { InvoiceTemplate, InvoiceDocumentData } from './invoice.template';

const DATA: InvoiceDocumentData = {
  clinic: {
    name: 'Ziyarati Clinic',
    legalName: 'Ziyarati Medical Co.',
    registrationNumber: 'CR-12345',
    contactEmail: 'clinic@example.test',
    contactPhone: '+966500000000',
  },
  patient: {
    name: 'محمد العتيبي',
    phone: '+966511111111',
    email: 'patient@example.test',
  },
  invoiceNumber: 'INV-2026-000001',
  issuedAt: '2026-01-15T00:00:00.000Z',
  currency: 'SAR',
  status: 'OPEN',
  items: [
    {
      description: 'Consultation',
      quantity: 1,
      unitPrice: 150,
      lineTotal: 150,
    },
    { description: 'X-Ray', quantity: 2, unitPrice: 32.86, lineTotal: 65.72 },
  ],
  total: 215.72,
};

describe('InvoiceTemplate (T094 — FR-I002, FR-I006, FR-I011)', () => {
  const template = new InvoiceTemplate();

  it.each(['en', 'ar'] as const)(
    'produces every FR-I002 field with no invented tax/discount line (%s)',
    (locale) => {
      const blocks = template.toBlocks(DATA, locale);

      const heading = blocks.find((b) => b.type === 'heading');
      expect(heading).toMatchObject({
        type: 'heading',
        text: 'Ziyarati Clinic',
      });

      const allText = JSON.stringify(blocks);
      expect(allText).toContain('CR-12345');
      expect(allText).toContain('INV-2026-000001');
      expect(allText).toContain('2026-01-15T00:00:00.000Z');
      expect(allText).toContain('SAR');
      expect(allText).toContain('OPEN');
      expect(allText).toContain('Consultation');
      expect(allText).toContain('215.72');

      // FR-I006 — no tax/discount line may ever appear.
      expect(allText.toLowerCase()).not.toContain('tax');
      expect(allText.toLowerCase()).not.toContain('discount');

      const table = blocks.find((b) => b.type === 'table');
      expect(table).toBeDefined();
      if (table?.type === 'table') {
        expect(table.headers).toHaveLength(4);
        expect(table.rows).toHaveLength(2);
      }
    },
  );

  it('renders no patient block when the invoice has no linked customer', () => {
    const blocks = template.toBlocks({ ...DATA, patient: null }, 'en');
    const invoiceKeyValue = blocks.find(
      (b, i) => b.type === 'keyValue' && i > 0,
    );
    expect(JSON.stringify(invoiceKeyValue)).not.toContain('Patient');
  });
});

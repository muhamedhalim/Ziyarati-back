import { DocumentBlock, DocumentTemplate } from '../document-blocks';

/**
 * Spec 014 (Clinic Platform Completion) — T094 (US12, FR-I002, FR-I006).
 *
 * Renders from data the caller already assembled and authorized — this
 * template performs no data access of its own (no repository, no tenant
 * context). Every field in FR-I002 is laid out; NO tax or discount line is
 * ever produced (FR-I006 — the schema records neither, so none may be
 * invented). Line items carry no currency of their own (see `InvoiceItem`),
 * so every amount here is, by construction, already in `data.currency` —
 * there is nothing to reconcile (FR-I005b).
 */
export interface InvoiceDocumentClinic {
  name: string;
  legalName?: string | null;
  registrationNumber?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface InvoiceDocumentPatient {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface InvoiceDocumentItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface InvoiceDocumentData {
  clinic: InvoiceDocumentClinic;
  patient?: InvoiceDocumentPatient | null;
  invoiceNumber: string;
  issuedAt: string;
  currency: string;
  status: string;
  items: InvoiceDocumentItem[];
  total: number;
}

const LABELS = {
  en: {
    legalName: 'Legal name',
    registrationNumber: 'Registration number',
    contact: 'Contact',
    invoiceNumber: 'Invoice number',
    issueDate: 'Issue date',
    patient: 'Patient',
    status: 'Status',
    description: 'Description',
    quantity: 'Qty',
    unitPrice: 'Unit price',
    lineTotal: 'Line total',
    total: 'Total',
    currency: 'Currency',
  },
  ar: {
    legalName: 'الاسم القانوني',
    registrationNumber: 'رقم السجل التجاري',
    contact: 'التواصل',
    invoiceNumber: 'رقم الفاتورة',
    issueDate: 'تاريخ الإصدار',
    patient: 'المريض',
    status: 'الحالة',
    description: 'الوصف',
    quantity: 'الكمية',
    unitPrice: 'سعر الوحدة',
    lineTotal: 'إجمالي البند',
    total: 'الإجمالي',
    currency: 'العملة',
  },
} as const;

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

function joinContact(email?: string | null, phone?: string | null): string {
  return [email, phone].filter(Boolean).join(' · ') || '—';
}

export class InvoiceTemplate implements DocumentTemplate {
  toBlocks(rawData: unknown, locale: 'ar' | 'en'): DocumentBlock[] {
    const data = rawData as InvoiceDocumentData;
    const t = LABELS[locale];

    const clinicRows: { label: string; value: string }[] = [];
    if (data.clinic.legalName) {
      clinicRows.push({ label: t.legalName, value: data.clinic.legalName });
    }
    if (data.clinic.registrationNumber) {
      clinicRows.push({
        label: t.registrationNumber,
        value: data.clinic.registrationNumber,
      });
    }
    clinicRows.push({
      label: t.contact,
      value: joinContact(data.clinic.contactEmail, data.clinic.contactPhone),
    });

    const invoiceRows: { label: string; value: string }[] = [
      { label: t.invoiceNumber, value: data.invoiceNumber },
      { label: t.issueDate, value: data.issuedAt },
      { label: t.status, value: data.status },
      { label: t.currency, value: data.currency },
    ];
    if (data.patient) {
      invoiceRows.splice(2, 0, {
        label: t.patient,
        value: [
          data.patient.name,
          joinContact(data.patient.email, data.patient.phone),
        ]
          .filter(Boolean)
          .join(' — '),
      });
    }

    return [
      { type: 'heading', text: data.clinic.name },
      { type: 'keyValue', rows: clinicRows },
      { type: 'spacer' },
      { type: 'keyValue', rows: invoiceRows },
      { type: 'spacer' },
      {
        type: 'table',
        headers: [t.description, t.quantity, t.unitPrice, t.lineTotal],
        rows: data.items.map((item) => [
          item.description,
          String(item.quantity),
          money(item.unitPrice, data.currency),
          money(item.lineTotal, data.currency),
        ]),
      },
      { type: 'spacer' },
      {
        type: 'keyValue',
        rows: [{ label: t.total, value: money(data.total, data.currency) }],
      },
    ];
  }
}

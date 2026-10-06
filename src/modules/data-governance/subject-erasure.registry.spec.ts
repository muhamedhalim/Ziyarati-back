import {
  compileStatement,
  ERASURE_STEPS,
  KNOWN_GAPS,
  statementFor,
  type ErasureParams,
} from './subject-erasure.registry';
import { classifyTable } from './data-classification';
import {
  customerForeignKeys,
  loadEntityMetadata,
} from './entity-metadata.test-util';

/**
 * Residency plan P11/P13 — the erasure plan is checked against the REAL schema,
 * so a new table that points at a patient cannot be added without deciding what
 * happens to it on a deletion request. (The statements themselves are executed
 * against PostgreSQL by test/integration/subject-erasure.int-spec.ts.)
 */
describe('subject erasure plan', () => {
  const stepTables = new Set(ERASURE_STEPS.map((s) => s.table));

  it('has a step for EVERY table with a foreign key to customers', async () => {
    const uncovered = (await customerForeignKeys())
      .map((f) => f.table)
      .filter((t) => !stepTables.has(t));
    expect(uncovered).toEqual([]);
  });

  it('covers tables that reference a customer without a declared foreign key', async () => {
    // e.g. ai_memories.customer_id — a missed FK would otherwise be invisible.
    const metas = await loadEntityMetadata();
    const fkTables = new Set((await customerForeignKeys()).map((f) => f.table));
    const keyed = metas
      .filter((m) => m.tableName !== 'customers')
      .filter((m) =>
        m.columns.some((c) => /^customer_?id$/i.test(c.databaseName)),
      )
      .map((m) => m.tableName)
      .filter((t) => !fkTables.has(t));
    expect(keyed.filter((t) => !stepTables.has(t))).toEqual([]);
  });

  it('names only tables and columns that exist', async () => {
    const metas = new Map(
      (await loadEntityMetadata()).map((m) => [m.tableName, m]),
    );
    const problems: string[] = [];
    for (const step of ERASURE_STEPS) {
      const meta = metas.get(step.table);
      if (!meta) {
        problems.push(`${step.id}: unknown table ${step.table}`);
        continue;
      }
      const cols = new Set(meta.columns.map((c) => c.databaseName));
      // Every column the statement assigns must exist on the table it updates.
      for (const m of (step.set ?? '').matchAll(/"([A-Za-z_]+)"s*=/g)) {
        if (!cols.has(m[1]))
          problems.push(`${step.id}: ${step.table} has no column ${m[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every table a classification, so the plan and the DPIA inventory agree', () => {
    expect(
      ERASURE_STEPS.filter((s) => !classifyTable(s.table)).map((s) => s.id),
    ).toEqual([]);
  });

  it('scopes every statement to a tenant (a customer id alone is never the guard)', () => {
    // customer_tag_relations has no tenant column; it is a pure child of the
    // customer, which the service has already verified belongs to the tenant.
    const NO_TENANT_COLUMN = new Set(['customer_tag_relations']);
    expect(
      ERASURE_STEPS.filter(
        (s) => !NO_TENANT_COLUMN.has(s.id) && !/:tenant/.test(s.where),
      ).map((s) => s.id),
    ).toEqual([]);
  });

  it('gives every retained / records step a reason an operator can read', () => {
    expect(
      ERASURE_STEPS.filter(
        (s) => s.group !== 'identity' && (s.reason?.trim().length ?? 0) <= 20,
      ).map((s) => s.id),
    ).toEqual([]);
  });

  it('keeps each action consistent with the statement it needs', () => {
    const needsSet = (a: string) => a === 'scrub' || a === 'anonymise';
    expect(
      ERASURE_STEPS.filter((s) => needsSet(s.action) !== !!s.set).map(
        (s) => s.id,
      ),
    ).toEqual([]);
    expect(new Set(ERASURE_STEPS.map((s) => s.id)).size).toBe(
      ERASURE_STEPS.length,
    );
  });

  it('never deletes accounting, payment or audit tables', () => {
    const PROTECTED = [
      'invoices',
      'invoice_items',
      'payments',
      'refunds',
      'transactions',
      'clinical_access_logs',
      'audit_logs',
    ];
    expect(
      ERASURE_STEPS.filter(
        (s) => PROTECTED.includes(s.table) && s.action !== 'retain',
      ).map((s) => s.id),
    ).toEqual([]);
  });

  it('orders the steps so every lookup still works: records first, identity next, the customer row LAST', () => {
    const idx = (id: string) => ERASURE_STEPS.findIndex((s) => s.id === id);
    const mutating = ERASURE_STEPS.filter((s) => s.action !== 'retain');
    expect(mutating[mutating.length - 1].id).toBe('customers');
    // AI conversations are found through whatsapp_contacts, which is deleted in identity.
    expect(idx('ai_conversations')).toBeLessThan(idx('whatsapp_contacts'));
    // Appointment-scoped steps run while the appointment still points at the customer.
    expect(idx('appointment_notes')).toBeLessThan(idx('customers'));
    const lastRecords = Math.max(
      ...ERASURE_STEPS.map((s, i) => (s.group === 'records' ? i : -1)),
    );
    const firstIdentity = ERASURE_STEPS.findIndex(
      (s) => s.group === 'identity',
    );
    expect(lastRecords).toBeLessThan(firstIdentity);
  });

  it('declares what it cannot reach, so a deletion is never read as more complete than it is', () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(5);
    const targets = KNOWN_GAPS.map((g) => g.target).join(' ');
    for (const needle of ['backups', 'Redis', 'logs', 'processor'])
      expect(targets).toContain(needle);
  });
});

describe('compileStatement', () => {
  const values: ErasureParams = {
    tenant: 'T',
    customer: 'C',
    terms: ['%1%'],
    emails: ['a@b.c'],
  };

  it('numbers placeholders in first-use order and reuses a number for a repeated name', () => {
    const c = compileStatement(
      `SELECT 1 WHERE a = :customer AND b = :tenant AND c IN (:customer)`,
      values,
    );
    expect(c.text).toBe('SELECT 1 WHERE a = $1 AND b = $2 AND c IN ($1)');
    expect(c.params).toEqual(['C', 'T']);
  });

  it('never interpolates a value into the SQL text', () => {
    for (const step of ERASURE_STEPS) {
      const { text } = statementFor(step, {
        ...values,
        customer: 'SECRET-CUSTOMER',
        tenant: 'SECRET-TENANT',
      });
      expect(text).not.toContain('SECRET');
      expect(text).not.toMatch(/:(tenant|customer|terms|emails)\b/);
    }
  });

  it('passes only the parameters a statement uses (the driver rejects extras)', () => {
    const del = statementFor(
      ERASURE_STEPS.find((s) => s.id === 'customer_tag_relations')!,
      values,
    );
    expect(del.params).toEqual(['C']);
  });

  it('builds DELETE / UPDATE / count statements by action', () => {
    const by = (id: string) =>
      statementFor(ERASURE_STEPS.find((s) => s.id === id)!, values).text;
    expect(by('customer_addresses')).toMatch(
      /^DELETE FROM "customer_addresses" WHERE/,
    );
    expect(by('customers')).toMatch(/^UPDATE "customers" SET/);
    expect(by('invoices')).toMatch(
      /^SELECT count\(\*\)::int AS n FROM "invoices" WHERE/,
    );
  });
});

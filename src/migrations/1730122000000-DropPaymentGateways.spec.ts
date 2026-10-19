import { DropPaymentGateways1730122000000 } from './1730122000000-DropPaymentGateways';

/** Runs `up()` with canned answers, in the order its queries are issued. */
async function runUp(answers: unknown[]) {
  const query = jest.fn();
  for (const a of answers) query.mockResolvedValueOnce(a);
  query.mockResolvedValue([]);
  const run = new DropPaymentGateways1730122000000().up({ query } as never);
  const sql = () => query.mock.calls.map(([s]) => s as string);
  return { run, sql };
}

describe('DropPaymentGateways1730122000000', () => {
  it('locks the table BEFORE counting, then drops it (atomic check + drop)', async () => {
    const { run, sql } = await runUp([
      [{ exists: true }],
      [], // LOCK
      [{ n: 0 }],
      [{ refs: 0 }],
    ]);
    await run;
    const s = sql();
    const lock = s.findIndex((x) =>
      /LOCK TABLE "payment_gateways" IN ACCESS EXCLUSIVE/.test(x),
    );
    const count = s.findIndex((x) =>
      /count\(\*\)::int AS n FROM "payment_gateways"/.test(x),
    );
    const drop = s.findIndex((x) => x === 'DROP TABLE "payment_gateways"');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(drop);
    expect(s.join('\n')).not.toMatch(/CASCADE/i);
  });

  it('REFUSES to drop a table that holds rows — nothing is dropped or deleted', async () => {
    const { run, sql } = await runUp([[{ exists: true }], [], [{ n: 3 }]]);
    await expect(run).rejects.toThrow(/holds 3 row/);
    expect(sql().some((x) => /DROP TABLE|DELETE|TRUNCATE/i.test(x))).toBe(
      false,
    );
  });

  it('REFUSES when a foreign key or view depends on it', async () => {
    const { run, sql } = await runUp([
      [{ exists: true }],
      [],
      [{ n: 0 }],
      [{ refs: 1 }],
    ]);
    await expect(run).rejects.toThrow(/depend on it/);
    expect(sql().some((x) => /DROP TABLE/i.test(x))).toBe(false);
  });

  it('is a no-op when the table is already gone', async () => {
    const { run, sql } = await runUp([[{ exists: false }]]);
    await run;
    expect(sql()).toHaveLength(1);
  });

  it('down() recreates the baseline structure and is re-runnable', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new DropPaymentGateways1730122000000().down({ query } as never);
    const s = query.mock.calls.map(([x]) => x as string).join('\n');
    expect(s).toContain('CREATE TABLE IF NOT EXISTS "payment_gateways"');
    expect(s).toContain('"gateway_name" character varying NOT NULL');
    expect(s).toContain('"config" jsonb');
    expect(s).toContain('PK_2b022a3aafb792a1afe3e14e06f');
    expect(s).toContain('FK_0290b49027c109e05d84ed6e693');
    expect(s).toContain('REFERENCES "tenants"("id")');
  });
});

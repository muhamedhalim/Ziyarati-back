import { Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { CANARY, leakedCanaries } from '../../../test/utils/log-canaries';
import { StructuredLogger } from './structured-logger';
import {
  SafeTypeOrmLogger,
  describeQueryFailure,
  sqlOperation,
  sqlTable,
} from './typeorm-safe-logger';

/**
 * LSA-01 regression: a failed statement must never put bound parameters,
 * driver DETAIL row values or ad-hoc SQL literals into ANY output — not the
 * structured log, and not the raw console that TypeORM's own loggers use.
 * All values are synthetic canaries (test/utils/log-canaries.ts).
 */

/** pg's DatabaseError shape, as TypeORM hands it to `logQueryError`. */
function pgError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? 'db error')), {
    name: 'error',
    ...fields,
  });
}

const PATIENT_PARAMS = [
  CANARY.nameEn,
  CANARY.nameAr,
  CANARY.phoneAscii,
  CANARY.clinicalNote,
  CANARY.nationalId,
  CANARY.email,
  CANARY.guardian,
  CANARY.appointmentReason,
];
const INSERT_SQL =
  'INSERT INTO "customers"("full_name", "full_name_ar", "phone", "notes", "national_id", "email", "guardian_name", "visit_reason") VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING "id"';

describe('SafeTypeOrmLogger (LSA-01)', () => {
  let lines: string[];
  let consoleOut: string[];
  const spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    lines = [];
    consoleOut = [];
    Logger.overrideLogger(
      new StructuredLogger({
        role: 'api',
        env: { NODE_ENV: 'production' },
        destination: { write: (s: string) => void lines.push(s) },
      }),
    );
    const grab =
      (sink: string[]) =>
      (...args: unknown[]) => {
        sink.push(
          args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        );
        return true;
      };
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(jest.spyOn(console, m).mockImplementation(grab(consoleOut)));
    }
    spies.push(
      jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(grab(consoleOut) as never),
      jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(grab(consoleOut) as never),
    );
  });

  afterEach(() => {
    spies.splice(0).forEach((s) => s.mockRestore());
    Logger.overrideLogger(['error']);
  });

  const everything = () => [...lines, ...consoleOut].join('\n');
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, any>);

  it('unique violation: logs SQLSTATE/constraint/table only — no parameter, no DETAIL value', () => {
    const logger = new SafeTypeOrmLogger(['error']);
    const err = pgError({
      message:
        'duplicate key value violates unique constraint "uq_customers_tenant_phone"',
      code: '23505',
      constraint: 'uq_customers_tenant_phone',
      table: 'customers',
      schema: 'public',
      detail: `Key (lower(full_name::text))=(${CANARY.nameEn.toLowerCase()}) already exists.`,
      where: `SQL statement "${CANARY.phoneAscii}"`,
    });

    logger.logQueryError(err, INSERT_SQL, PATIENT_PARAMS);

    const out = everything();
    expect(leakedCanaries(out)).toEqual([]);
    expect(out).not.toMatch(/PARAMETERS/);
    expect(out).not.toMatch(/already exists|Key \(/);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      level: 'warn',
      event: 'database.query.failed',
      operation: 'INSERT',
      table: 'customers',
      sqlstate: '23505',
      constraint: 'uq_customers_tenant_phone',
      db_table: 'customers',
      context: 'TypeORM',
    });
  });

  it('exclusion-constraint booking race (23P01) and not-null (23502) keep their diagnostics', () => {
    const logger = new SafeTypeOrmLogger(['error']);
    logger.logQueryError(
      pgError({
        message:
          'conflicting key value violates exclusion constraint "ex_appointments_no_overlap"',
        code: '23P01',
        constraint: 'ex_appointments_no_overlap',
        table: 'appointments',
        detail: `Key (doctor_id, tstzrange(starts_at, ends_at))=(${CANARY.dbParam}) conflicts with existing key`,
      }),
      'INSERT INTO "appointments"("doctor_id","reason") VALUES ($1,$2)',
      [CANARY.dbParam, CANARY.appointmentReason],
    );
    logger.logQueryError(
      pgError({
        message:
          'null value in column "phone" of relation "customers" violates not-null constraint',
        code: '23502',
        column: 'phone',
        table: 'customers',
        detail: `Failing row contains (${CANARY.nameEn}, null, ${CANARY.clinicalNote}).`,
      }),
      'INSERT INTO "customers"("full_name","phone","notes") VALUES ($1,$2,$3)',
      [CANARY.nameEn, null, CANARY.clinicalNote],
    );
    expect(leakedCanaries(everything())).toEqual([]);
    const [a, b] = records();
    expect(a).toMatchObject({
      sqlstate: '23P01',
      constraint: 'ex_appointments_no_overlap',
      table: 'appointments',
    });
    expect(b).toMatchObject({
      sqlstate: '23502',
      db_column: 'phone',
      table: 'customers',
    });
  });

  it('invalid-input error whose MESSAGE quotes the value is not echoed', () => {
    const logger = new SafeTypeOrmLogger(['error']);
    logger.logQueryError(
      pgError({
        message: `invalid input syntax for type uuid: "${CANARY.phoneIntl}"`,
        code: '22P02',
      }),
      'SELECT "c"."id" FROM "customers" "c" WHERE "c"."id" = $1',
      [CANARY.phoneIntl],
    );
    expect(leakedCanaries(everything())).toEqual([]);
    expect(records()[0]).toMatchObject({
      operation: 'SELECT',
      table: 'customers',
      sqlstate: '22P02',
    });
  });

  it('a TypeORM QueryFailedError wrapping the driver error (nested) is reduced the same way', () => {
    const logger = new SafeTypeOrmLogger(['error']);
    const driverError = pgError({
      message: 'duplicate key value violates unique constraint "uq_x"',
      code: '23505',
      constraint: 'uq_x',
      detail: `Key (national_id)=(${CANARY.nationalId}) already exists.`,
    });
    const wrapped = new QueryFailedError(
      INSERT_SQL,
      PATIENT_PARAMS,
      driverError,
    );
    logger.logQueryError(wrapped, INSERT_SQL, PATIENT_PARAMS);
    expect(leakedCanaries(everything())).toEqual([]);
    expect(records()[0]).toMatchObject({
      error_type: 'QueryFailedError',
      sqlstate: '23505',
      constraint: 'uq_x',
    });
  });

  it('ad-hoc SQL with inline literals: the statement text is never written', () => {
    const logger = new SafeTypeOrmLogger(['error']);
    logger.logQueryError(
      'canceling statement due to statement timeout',
      `SELECT * FROM customers WHERE phone = '${CANARY.phoneAscii}' OR full_name ILIKE '%${CANARY.nameEn}%' OR email = '${CANARY.email}'`,
      [],
    );
    expect(leakedCanaries(everything())).toEqual([]);
    expect(records()[0]).toMatchObject({
      operation: 'SELECT',
      table: 'customers',
      error_type: 'DriverError',
    });
  });

  it('slow query: duration, verb and table only', () => {
    const logger = new SafeTypeOrmLogger(['error']);
    logger.logQuerySlow(2_345.6, INSERT_SQL, PATIENT_PARAMS);
    expect(leakedCanaries(everything())).toEqual([]);
    expect(records()[0]).toMatchObject({
      event: 'database.query.slow',
      operation: 'INSERT',
      table: 'customers',
      duration_ms: 2346,
    });
  });

  it('per-statement echo (dev-only TYPEORM_LOGGING) never prints parameters either', () => {
    const logger = new SafeTypeOrmLogger(['query', 'error', 'warn']);
    logger.logQuery(INSERT_SQL, PATIENT_PARAMS);
    const out = everything();
    expect(out).toContain('INSERT INTO');
    expect(leakedCanaries(out)).toEqual([]);
    expect(out).not.toMatch(/PARAMETERS/);
  });

  it('error logging off (logging=false) writes nothing', () => {
    const logger = new SafeTypeOrmLogger(false);
    logger.logQueryError(
      pgError({ message: 'x', code: '23505' }),
      INSERT_SQL,
      PATIENT_PARAMS,
    );
    expect(everything()).toBe('');
  });

  it('never throws, even for hostile inputs', () => {
    const logger = new SafeTypeOrmLogger(['error']);
    const hostile = {
      get code() {
        throw new Error('boom');
      },
    } as unknown as Error;
    expect(() =>
      logger.logQueryError(hostile, undefined as unknown as string, undefined),
    ).not.toThrow();
    expect(() =>
      logger.logQuerySlow(NaN, null as unknown as string),
    ).not.toThrow();
  });
});

describe('describeQueryFailure / sqlOperation / sqlTable', () => {
  it('only identifier-shaped driver metadata is kept', () => {
    const s = describeQueryFailure(
      pgError({
        code: '23505',
        constraint: `bad ${CANARY.nameEn}`,
        table: "customers'; --",
        column: CANARY.phoneAscii,
      }),
      'UPDATE "public"."customers" SET "notes" = $1 WHERE "id" = $2',
    );
    expect(s).toEqual({
      operation: 'UPDATE',
      table: 'customers',
      sqlstate: '23505',
      error_type: 'error',
    });
  });

  it('rejects a non-SQLSTATE code', () => {
    expect(
      describeQueryFailure(pgError({ code: CANARY.phoneAscii }), 'SELECT 1')
        .sqlstate,
    ).toBeUndefined();
  });

  it.each([
    ['  /* typeorm */ SELECT 1', 'SELECT'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'WITH'],
    ['delete from "appointments" where id = $1', 'DELETE'],
    [`${CANARY.nameEn} SELECT`, 'OTHER'],
    ['', 'OTHER'],
  ])('sqlOperation(%p) = %p', (sql, op) => {
    expect(sqlOperation(sql)).toBe(op);
  });

  it.each([
    ['SELECT * FROM "customers" "c"', 'customers'],
    ['INSERT INTO "public"."appointments"("id") VALUES ($1)', 'appointments'],
    ['UPDATE ONLY whatsapp_templates SET x = 1', 'whatsapp_templates'],
    [`SELECT '${CANARY.nameEn}'`, undefined],
  ])('sqlTable(%p) = %p', (sql, table) => {
    expect(sqlTable(sql)).toBe(table);
  });
});

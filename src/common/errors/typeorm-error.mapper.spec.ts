import { QueryFailedError } from 'typeorm';

import { mapTypeOrmError } from './typeorm-error.mapper';
import { AppError } from './app-error';
import { ErrorCode } from './error-code';

/** The mapper reads `.code/.constraint/.column` straight off the error object. */
const pgError = (driver: Record<string, unknown>) => driver as unknown as QueryFailedError;

describe('mapTypeOrmError', () => {
  it('maps a unique violation to UNIQUE_VIOLATION with a friendly constraint message', () => {
    const err = mapTypeOrmError(pgError({ code: '23505', constraint: 'uq_user_tenant_email' }));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCode.UNIQUE_VIOLATION);
    expect(err.message).toBe('Email already exists in this tenant');
  });

  it('maps an exclusion violation (double-booking) to a clean CONFLICT', () => {
    const err = mapTypeOrmError(pgError({ code: '23P01', constraint: 'appointments_no_overlap' }));
    expect(err.code).toBe(ErrorCode.CONFLICT);
    expect(err.message).toMatch(/just booked/i);
  });

  it('falls back to a generic message for an unknown exclusion constraint', () => {
    const err = mapTypeOrmError(pgError({ code: '23P01', constraint: 'something_else' }));
    expect(err.code).toBe(ErrorCode.CONFLICT);
    expect(err.message).toMatch(/no longer available/i);
  });

  it('maps a foreign-key violation', () => {
    expect(mapTypeOrmError(pgError({ code: '23503' })).code).toBe(ErrorCode.FOREIGN_KEY_VIOLATION);
  });

  it('maps a not-null violation and surfaces the column as a field', () => {
    const err = mapTypeOrmError(pgError({ code: '23502', column: 'email' }));
    expect(err.code).toBe(ErrorCode.NOT_NULL_VIOLATION);
    expect(err.message).toContain('email');
    expect(err.context).toEqual({ field: 'email' });
  });

  it('maps invalid text representation and check violation to BAD_REQUEST', () => {
    expect(mapTypeOrmError(pgError({ code: '22P02' })).code).toBe(ErrorCode.BAD_REQUEST);
    expect(mapTypeOrmError(pgError({ code: '23514' })).code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('maps an unknown SQLSTATE to DATABASE_ERROR', () => {
    expect(mapTypeOrmError(pgError({ code: '99999' })).code).toBe(ErrorCode.DATABASE_ERROR);
  });

  describe('no internal detail ever reaches the client', () => {
    it('falls back to a generic message for a unique violation on an unmapped constraint (never echoes the constraint name)', () => {
      const err = mapTypeOrmError(
        pgError({ code: '23505', constraint: 'some_future_unmapped_constraint' }),
      );
      expect(err.message).toBe('A record with these details already exists');
      expect(err.message).not.toContain('some_future_unmapped_constraint');
      expect(err.context).toBeUndefined();
    });

    it('never puts the SQLSTATE, table, or raw driver detail into context', () => {
      const err = mapTypeOrmError(
        pgError({
          code: '23503',
          table: 'internal_secrets_table',
          detail: 'Key (tenant_id)=(...) is not present in table "tenants".',
        }),
      );
      const serializedContext = JSON.stringify(err.context ?? {});
      expect(serializedContext).not.toContain('internal_secrets_table');
      expect(serializedContext).not.toContain('is not present in table');
    });

    it('preserves the raw driver error as `cause` for server-side logs only', () => {
      const raw = pgError({ code: '23505', constraint: 'uq_user_tenant_email' });
      const err = mapTypeOrmError(raw);
      expect(err.cause).toBe(raw);
    });

    it('the only context ever produced (NOT_NULL_VIOLATION) carries just the field name, nothing else', () => {
      const err = mapTypeOrmError(
        pgError({ code: '23502', column: 'email', table: 'users', detail: 'internal detail' }),
      );
      expect(err.context).toEqual({ field: 'email' });
    });
  });
});

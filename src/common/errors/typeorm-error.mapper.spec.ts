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
});

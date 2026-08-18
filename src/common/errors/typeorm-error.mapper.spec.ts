import { QueryFailedError } from 'typeorm';

import { mapTypeOrmError } from './typeorm-error.mapper';
import { AppError } from './app-error';
import { ErrorCode } from './error-code';

/** The mapper reads `.code/.constraint/.column` straight off the error object. */
const pgError = (driver: Record<string, unknown>) => driver as unknown as QueryFailedError;

describe('mapTypeOrmError', () => {
  it('maps a unique violation to UNIQUE_VIOLATION with a friendly constraint message', () => {
    const err = mapTypeOrmError(pgError({ code: '23505', constraint: 'uq_user_email_global' }));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCode.UNIQUE_VIOLATION);
    expect(err.message).toBe('This email is already in use');
  });

  // Losing a booking race is its own outcome: the client should refresh the
  // available slots and re-pick, which is a different action from every other
  // 409 — hence a dedicated code rather than the generic CONFLICT.
  it('maps the appointment overlap violation to SLOT_ALREADY_BOOKED', () => {
    const err = mapTypeOrmError(pgError({ code: '23P01', constraint: 'appointments_no_overlap' }));
    expect(err.code).toBe(ErrorCode.SLOT_ALREADY_BOOKED);
    expect(err.message).toMatch(/just booked/i);
  });

  it('never leaks the constraint name to the client', () => {
    const err = mapTypeOrmError(pgError({ code: '23P01', constraint: 'appointments_no_overlap' }));
    expect(err.message).not.toContain('appointments_no_overlap');
    expect(err.publicContext).toBeUndefined();
  });

  it('falls back to a generic CONFLICT for any other exclusion constraint', () => {
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
    expect(err.publicContext).toEqual({ field: 'email' });
  });

  it('maps invalid text representation and check violation to BAD_REQUEST', () => {
    expect(mapTypeOrmError(pgError({ code: '22P02' })).code).toBe(ErrorCode.BAD_REQUEST);
    expect(mapTypeOrmError(pgError({ code: '23514' })).code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('maps an unknown SQLSTATE to DATABASE_ERROR', () => {
    expect(mapTypeOrmError(pgError({ code: '99999' })).code).toBe(ErrorCode.DATABASE_ERROR);
  });

  describe('no internal detail ever reaches publicContext', () => {
    it('falls back to a generic message for a unique violation on an unmapped constraint (never echoes the constraint name)', () => {
      const err = mapTypeOrmError(
        pgError({ code: '23505', constraint: 'some_future_unmapped_constraint' }),
      );
      expect(err.message).toBe('A record with these details already exists');
      expect(err.message).not.toContain('some_future_unmapped_constraint');
      expect(err.publicContext).toBeUndefined();
    });

    it('never puts the SQLSTATE, table, or raw driver detail into publicContext — only in internalContext (logs)', () => {
      const err = mapTypeOrmError(
        pgError({
          code: '23503',
          table: 'internal_secrets_table',
          detail: 'Key (tenant_id)=(...) is not present in table "tenants".',
        }),
      );
      // Never in the client-facing field...
      const serializedPublic = JSON.stringify(err.publicContext ?? {});
      expect(serializedPublic).not.toContain('internal_secrets_table');
      expect(serializedPublic).not.toContain('is not present in table');

      // ...but present in the server-log-only field, so operators can still diagnose it.
      expect(err.internalContext).toMatchObject({
        sqlState: '23503',
        table: 'internal_secrets_table',
        detail: 'Key (tenant_id)=(...) is not present in table "tenants".',
      });
    });

    it('preserves the raw driver error as `cause` for server-side logs only', () => {
      const raw = pgError({ code: '23505', constraint: 'uq_user_email_global' });
      const err = mapTypeOrmError(raw);
      expect(err.cause).toBe(raw);
    });

    it('the only publicContext ever produced (NOT_NULL_VIOLATION) carries just the field name, nothing else', () => {
      const err = mapTypeOrmError(
        pgError({ code: '23502', column: 'email', table: 'users', detail: 'internal detail' }),
      );
      expect(err.publicContext).toEqual({ field: 'email' });
      // The table/detail still land in internalContext for logs, never publicContext.
      expect(err.internalContext).toMatchObject({ table: 'users', detail: 'internal detail' });
    });

    it('every branch attaches internalContext for log-side diagnostics', () => {
      const codes = ['23505', '23P01', '23503', '23502', '22P02', '23514', '99999'];
      for (const code of codes) {
        const err = mapTypeOrmError(pgError({ code, constraint: 'some_constraint' }));
        expect(err.internalContext).toMatchObject({ sqlState: code });
      }
    });
  });
});

import { HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import {
  EntityNotFoundError,
  OptimisticLockVersionMismatchError,
  QueryFailedError,
} from 'typeorm';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-code';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let json: jest.Mock;
  let status: jest.Mock;
  let setHeader: jest.Mock;
  let getHeader: jest.Mock;
  let host: any;
  let request: any;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    setHeader = jest.fn();
    getHeader = jest.fn().mockReturnValue(undefined);
    request = {
      requestId: 'req-1',
      method: 'POST',
      originalUrl: '/api/v1/x',
      user: { id: 'u1', tenantId: 't1' },
      body: { password: 'secret', email: 'a@b.com' },
    };
    host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ status, setHeader, getHeader }),
      }),
    };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const bodySent = () => json.mock.calls[0][0];

  it('renders the canonical shape for an AppError', () => {
    filter.catch(new AppError(ErrorCode.FORBIDDEN, { message: 'no' }), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(bodySent()).toMatchObject({ code: ErrorCode.FORBIDDEN, requestId: 'req-1', path: '/api/v1/x' });
  });

  describe('Retry-After', () => {
    it('sets it (rounded UP to whole seconds) from a 429\'s own retryAfterMs hint', () => {
      filter.catch(
        new AppError(ErrorCode.RATE_LIMITED, { publicContext: { retryAfterMs: 2_300 } }),
        host,
      );
      expect(status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '3');
    });

    it('falls back to a full 60 s window for a 429 with no hint', () => {
      filter.catch(new AppError(ErrorCode.RATE_LIMITED, { message: 'slow down' }), host);
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
    });

    it('sets it on a 503 that carries a hint', () => {
      filter.catch(
        new AppError(ErrorCode.SERVICE_UNAVAILABLE, { publicContext: { retryAfterMs: 5_000 } }),
        host,
      );
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '5');
    });

    it('sets NOTHING for a 503 without a hint (no honest estimate, e.g. maintenance)', () => {
      filter.catch(new AppError(ErrorCode.SERVICE_UNAVAILABLE, { message: 'maintenance' }), host);
      expect(setHeader).not.toHaveBeenCalled();
    });

    it('clamps an absurd or tiny hint into [1, 3600] seconds', () => {
      filter.catch(new AppError(ErrorCode.RATE_LIMITED, { publicContext: { retryAfterMs: 50 } }), host);
      filter.catch(new AppError(ErrorCode.RATE_LIMITED, { publicContext: { retryAfterMs: 9_999_999_999 } }), host);
      expect(setHeader.mock.calls.map((c) => c[1])).toEqual(['1', '3600']);
    });

    it.each([0, -5, Number.NaN, 'soon'])('ignores an invalid hint (%p) and uses the 429 default', (bad) => {
      filter.catch(new AppError(ErrorCode.RATE_LIMITED, { publicContext: { retryAfterMs: bad as never } }), host);
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
    });

    it('never overrides a Retry-After that something upstream already set', () => {
      getHeader.mockReturnValue('42');
      filter.catch(new AppError(ErrorCode.RATE_LIMITED, { publicContext: { retryAfterMs: 2_000 } }), host);
      expect(setHeader).not.toHaveBeenCalled();
    });

    it('is never set for other statuses', () => {
      filter.catch(new AppError(ErrorCode.FORBIDDEN, { publicContext: { retryAfterMs: 2_000 } }), host);
      filter.catch(new AppError(ErrorCode.CONFLICT, { message: 'x' }), host);
      expect(setHeader).not.toHaveBeenCalled();
    });

    it('the hint still reaches the JSON body\'s context (unchanged behaviour)', () => {
      filter.catch(new AppError(ErrorCode.RATE_LIMITED, { publicContext: { retryAfterMs: 2_000 } }), host);
      expect(bodySent().context).toMatchObject({ retryAfterMs: 2_000 });
    });
  });

  it('maps a QueryFailedError (unique violation) to a 409', () => {
    const err = Object.assign(new QueryFailedError('q', [], new Error('dup')), { code: '23505' });
    filter.catch(err, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(bodySent().code).toBe(ErrorCode.UNIQUE_VIOLATION);
  });

  it('maps an EntityNotFoundError to 404', () => {
    filter.catch(new EntityNotFoundError('X', {}), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(bodySent().code).toBe(ErrorCode.NOT_FOUND);
  });

  it('maps an optimistic-lock mismatch to 409', () => {
    filter.catch(new OptimisticLockVersionMismatchError('X', 1, 2), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('maps a class-validator HttpException (array message) to VALIDATION_ERROR', () => {
    const exc = new HttpException({ message: ['email must be valid', 'name required'] }, HttpStatus.BAD_REQUEST);
    filter.catch(exc, host);
    expect(bodySent().code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(Array.isArray(bodySent().message)).toBe(true);
  });

  it('maps a generic HttpException by its status', () => {
    filter.catch(new NotFoundException('missing'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(bodySent().code).toBe(ErrorCode.NOT_FOUND);
  });

  it('treats an unknown error as a 500 (message hidden in production)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const prodFilter = new AllExceptionsFilter();
    prodFilter.catch(new Error('internal db dsn leak'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(bodySent().message).toBe('An unexpected error occurred');
    process.env.NODE_ENV = prev;
  });

  it('includes a dev stack and sanitizes the logged body', () => {
    filter.catch(new Error('boom'), host); // non-prod → stack in context
    expect(bodySent().context?.stack).toBeDefined();
  });

  // ── Development vs. production safety ──────────────────────────────────── //
  describe('environment-gated safety (development vs. production)', () => {
    const withEnv = (env: string, fn: () => void) => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = env;
      try {
        fn();
      } finally {
        process.env.NODE_ENV = prev;
      }
    };

    describe('development', () => {
      it('shows the real message, the real error class name, and the stack for an unexpected error', () => {
        withEnv('development', () => {
          const devFilter = new AllExceptionsFilter();
          devFilter.catch(new TypeError('cannot read property x of undefined'), host);
          const b = bodySent();
          expect(b.message).toBe('cannot read property x of undefined');
          expect(b.error).toBe('TypeError');
          expect(b.context?.stack).toBeDefined();
        });
      });

      it('shows the real "QueryFailedError" label as a diagnostic aid', () => {
        withEnv('development', () => {
          const devFilter = new AllExceptionsFilter();
          const err = Object.assign(new QueryFailedError('q', [], new Error('dup')), {
            code: '23505',
            constraint: 'uq_user_email_global',
          });
          devFilter.catch(err, host);
          expect(bodySent().error).toBe('QueryFailedError');
        });
      });
    });

    describe('production', () => {
      it('hides the real message and error class name for an unexpected error, showing only generic values', () => {
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          prodFilter.catch(new TypeError('leaked internal db connection string'), host);
          const b = bodySent();
          expect(b.message).toBe('An unexpected error occurred');
          expect(b.error).toBe('Internal Server Error');
          expect(b.message).not.toContain('leaked internal db connection string');
        });
      });

      it('never attaches a stack or any context for an unexpected error', () => {
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          prodFilter.catch(new Error('boom'), host);
          expect(bodySent().context).toBeUndefined();
        });
      });

      it('collapses the internal "QueryFailedError" class name to the generic "AppError" label', () => {
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          const err = Object.assign(new QueryFailedError('q', [], new Error('dup')), {
            code: '23505',
            constraint: 'uq_user_email_global',
          });
          prodFilter.catch(err, host);
          const b = bodySent();
          expect(b.error).toBe('AppError');
          expect(b.error).not.toBe('QueryFailedError');
        });
      });

      it('still forwards explicitly client-safe AppError context (not "internal" context)', () => {
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          // NOT_NULL_VIOLATION is the one mapTypeOrmError branch that sets context.
          const err = Object.assign(new QueryFailedError('q', [], new Error('null')), {
            code: '23502',
            column: 'email',
          });
          prodFilter.catch(err, host);
          const b = bodySent();
          expect(b.context).toEqual({ field: 'email' });
        });
      });

      it('forwards a directly-thrown AppError\'s message and context unchanged (already client-safe by contract)', () => {
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          prodFilter.catch(
            new AppError(ErrorCode.CONFLICT, {
              message: 'Only completed appointments can be reviewed',
              publicContext: { currentStatus: 'PENDING' },
            }),
            host,
          );
          const b = bodySent();
          expect(b.message).toBe('Only completed appointments can be reviewed');
          expect(b.context).toEqual({ currentStatus: 'PENDING' });
          expect(b.error).toBe('AppError');
        });
      });
    });

    describe('logs retain full detail in every environment', () => {
      it('logs the real message even when the client-facing message is hidden (production)', () => {
        const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          prodFilter.catch(new Error('leaked internal db connection string'), host);
        });
        const logged = errorSpy.mock.calls[0]?.[0] as string;
        expect(logged).toContain('leaked internal db connection string');
        errorSpy.mockRestore();
      });

      it('logs the real driver message for a mapped QueryFailedError, not the sanitized client message', () => {
        // A unique violation maps to 409 (CONFLICT) — an operational 4xx, so
        // writeLog() logs it via `.warn`, not `.error` (that's reserved for 5xx).
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          const err = Object.assign(
            new QueryFailedError('q', [], new Error('duplicate key value violates unique constraint "uq_user_email_global"')),
            { code: '23505', constraint: 'uq_user_email_global' },
          );
          prodFilter.catch(err, host);
        });
        const logged = warnSpy.mock.calls[0]?.[0] as string;
        expect(logged).toContain('duplicate key value violates unique constraint');
        // The client, meanwhile, only ever saw the friendly mapped message.
        expect(bodySent().message).toBe('This email is already in use');
        warnSpy.mockRestore();
      });

      it('still sanitizes the sensitive request body fields in logs regardless of environment', () => {
        const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          prodFilter.catch(new Error('boom'), host);
        });
        const logged = errorSpy.mock.calls[0]?.[0] as string;
        expect(logged).toContain('[REDACTED]');
        expect(logged).not.toContain('"password":"secret"');
        errorSpy.mockRestore();
      });

      it('never logs a customer search term (e.g. a national ID) carried in the query string', () => {
        const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        request.method = 'GET';
        request.originalUrl = '/api/v1/crm/customers/search?q=29801011234567&page=2&limit=20';
        request.body = {};
        filter.catch(new Error('boom'), host);

        const logged = errorSpy.mock.calls[0]?.[0] as string;
        expect(logged).not.toContain('29801011234567');
        // Operator can still see the route and the non-sensitive filters.
        expect(logged).toContain('/api/v1/crm/customers/search?q=[REDACTED]&page=2&limit=20');
        errorSpy.mockRestore();
      });

      it('never logs a national_id sent in a request body', () => {
        const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        request.body = { full_name: 'Sara', national_id: '29801011234567' };
        filter.catch(new Error('boom'), host);

        const logged = errorSpy.mock.calls[0]?.[0] as string;
        expect(logged).not.toContain('29801011234567');
        errorSpy.mockRestore();
      });
    });

    // ── publicContext / internalContext / cause separation ──────────────── //
    describe('publicContext is client-visible; internalContext and cause never are', () => {
      // status forced to 500 so writeLog()'s `.error` path (which attaches the
      // cause's stack trace) actually runs — a 4xx only logs via `.warn`.
      const buildError = () =>
        new AppError(ErrorCode.CONFLICT, {
          message: 'Refund was declined by the gateway',
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          publicContext: { requestedAmount: 42 },
          internalContext: { gatewayReason: 'insufficient_funds_raw_provider_text' },
          cause: new Error('POST https://gateway.example/refund -> 402 insufficient_funds'),
        });

      it('sends publicContext to the client in development', () => {
        withEnv('development', () => {
          const devFilter = new AllExceptionsFilter();
          devFilter.catch(buildError(), host);
          expect(bodySent().context).toMatchObject({ requestedAmount: 42 });
        });
      });

      it('sends publicContext to the client in production', () => {
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          prodFilter.catch(buildError(), host);
          expect(bodySent().context).toMatchObject({ requestedAmount: 42 });
        });
      });

      it('never sends internalContext or cause to the client in development', () => {
        withEnv('development', () => {
          const devFilter = new AllExceptionsFilter();
          devFilter.catch(buildError(), host);
          const raw = JSON.stringify(bodySent());
          expect(raw).not.toContain('gatewayReason');
          expect(raw).not.toContain('insufficient_funds_raw_provider_text');
          expect(raw).not.toContain('gateway.example');
          expect(bodySent().internalContext).toBeUndefined();
          expect(bodySent().cause).toBeUndefined();
        });
      });

      it('never sends internalContext or cause to the client in production', () => {
        withEnv('production', () => {
          const prodFilter = new AllExceptionsFilter();
          prodFilter.catch(buildError(), host);
          const raw = JSON.stringify(bodySent());
          expect(raw).not.toContain('gatewayReason');
          expect(raw).not.toContain('insufficient_funds_raw_provider_text');
          expect(raw).not.toContain('gateway.example');
          expect(bodySent().internalContext).toBeUndefined();
          expect(bodySent().cause).toBeUndefined();
        });
      });

      it('logs internalContext and the cause chain, in both environments', () => {
        for (const env of ['development', 'production']) {
          const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
          withEnv(env, () => {
            const f = new AllExceptionsFilter();
            f.catch(buildError(), host);
          });
          const loggedJson = errorSpy.mock.calls[0]?.[0] as string;
          const loggedTrace = errorSpy.mock.calls[0]?.[1] as string;
          expect(loggedJson).toContain('gatewayReason');
          expect(loggedJson).toContain('insufficient_funds_raw_provider_text');
          expect(loggedTrace).toContain('gateway.example');
          errorSpy.mockRestore();
        }
      });
    });
  });
});

// ── Residency plan P7 — what the error log may contain ────────────────────── //
describe('AllExceptionsFilter — log content (residency plan P7)', () => {
  let filter: AllExceptionsFilter;
  let request: any;
  let host: any;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    request = {
      requestId: 'req-p7',
      method: 'POST',
      originalUrl: '/api/v1/appointments',
      user: { id: 'u1', tenantId: 't1' },
      body: {},
    };
    const json = jest.fn();
    host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({
          status: jest.fn().mockReturnValue({ json }),
          setHeader: jest.fn(),
          getHeader: jest.fn().mockReturnValue(undefined),
        }),
      }),
    };
  });

  afterEach(() => jest.restoreAllMocks());

  const logged = (spy: jest.SpyInstance) => String(spy.mock.calls[0]?.[0]);

  it('never logs the text of a request body, only its shape', () => {
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    request.body = {
      reason: 'chest pain since Tuesday',
      visitNotes: 'patient is allergic to penicillin',
      branchId: 'br-1',
      urgent: true,
    };
    filter.catch(new Error('boom'), host);

    const line = logged(spy);
    expect(line).not.toContain('chest pain');
    expect(line).not.toContain('penicillin');
    expect(line).toContain('"reason":"[string:24]"');
    expect(line).toContain('"urgent":true');
  });

  it('scrubs row values out of a raw driver message', () => {
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    filter.catch(
      new Error('invalid input syntax for type uuid: "Sara Ahmed 0501234567"'),
      host,
    );

    const line = logged(spy);
    expect(line).not.toContain('Sara Ahmed');
    expect(line).not.toContain('0501234567');
    expect(line).toContain('invalid input syntax for type uuid');
  });

  it('scrubs the stack and the cause that are logged on a 5xx', () => {
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const cause = new Error('mailbox sara@example.com unavailable');
    const err = new AppError(ErrorCode.INTERNAL_ERROR, {
      message: 'send failed',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      cause,
    });
    filter.catch(err, host);

    const line = logged(spy);
    const stack = String(spy.mock.calls[0]?.[1]);
    expect(line).not.toContain('sara@example.com');
    expect(stack).not.toContain('sara@example.com');
    expect(stack).toContain('Caused by');
  });

  it('does not log a capability token carried in the URL path', () => {
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    request.originalUrl = '/api/v1/public/payments/Xk3PqR9vTn2LmB7wYz4HdC8s';
    filter.catch(new Error('boom'), host);
    expect(logged(spy)).not.toContain('Xk3PqR9vTn2LmB7wYz4HdC8s');
  });
});

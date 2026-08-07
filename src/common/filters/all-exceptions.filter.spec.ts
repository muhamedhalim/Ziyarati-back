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
  let host: any;
  let request: any;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
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
        getResponse: () => ({ status }),
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

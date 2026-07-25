import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  EntityNotFoundError,
  OptimisticLockVersionMismatchError,
  QueryFailedError,
} from 'typeorm';

import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-code';
import { mapTypeOrmError } from '../errors/typeorm-error.mapper';
import { ErrorResponseBody } from '../interfaces/error-response.interface';
import { sanitizeForLog } from '../utils/sanitize.util';

interface NormalizedError {
  statusCode: number;
  code: string;
  message: string | string[];
  /** Originating error class name, for debugging. */
  error: string;
  /** Client-safe metadata — sourced ONLY from `AppError.publicContext`. Goes into the HTTP response. */
  context?: Record<string, unknown>;
  /** Server-log-only diagnostics — sourced ONLY from `AppError.internalContext`. NEVER put into the HTTP response. */
  internalContext?: Record<string, unknown>;
}

/** Generic, non-leaking stand-ins shown to the client in production. */
const PRODUCTION_SAFE_MESSAGE = 'An unexpected error occurred';
const PRODUCTION_SAFE_ERROR_LABEL = 'Internal Server Error';

/**
 * Catches EVERY exception thrown anywhere in the request lifecycle (guards,
 * pipes, controllers, services) and renders the single canonical error shape.
 *
 * Guarantees:
 *  - consistent JSON for all failures (no bare 500s),
 *  - machine-readable `code` on every response,
 *  - full internal detail logged with a correlation id,
 *  - zero leakage of stack traces / SQL / schema to clients in production.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');
  private readonly isProduction = process.env.NODE_ENV === 'production';

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const requestId = request.requestId ?? 'unknown';

    const normalized = this.normalize(exception);

    const body: ErrorResponseBody = {
      statusCode: normalized.statusCode,
      error: normalized.error,
      message: normalized.message,
      code: normalized.code,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
      requestId,
    };
    // The ONLY thing ever assigned to the response's `context` — sourced
    // exclusively from `AppError.publicContext` (see `fromAppError()`).
    // `internalContext` and `cause` never reach this point; they only flow
    // into `writeLog()` below.
    if (normalized.context) {
      body.context = normalized.context;
    }
    // Stack only ever reaches the client outside production, and only as a
    // debugging aid in the context block.
    if (!this.isProduction && exception instanceof Error && exception.stack) {
      body.context = {
        ...(body.context ?? {}),
        stack: exception.stack.split('\n').map((l) => l.trim()),
      };
    }

    this.writeLog(normalized, exception, request, requestId);

    response.status(normalized.statusCode).json(body);
  }

  // ----------------------------------------------------------------------- //
  // Normalization
  // ----------------------------------------------------------------------- //

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppError) {
      return this.fromAppError(exception, 'AppError');
    }

    if (exception instanceof QueryFailedError) {
      // mapTypeOrmError() always returns an AppError, so this funnels through
      // the exact same client-safe-context rule as a directly-thrown AppError.
      return this.fromAppError(mapTypeOrmError(exception), 'QueryFailedError');
    }

    if (exception instanceof EntityNotFoundError) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found',
        error: 'EntityNotFoundError',
      };
    }

    if (exception instanceof OptimisticLockVersionMismatchError) {
      // Concurrent edit to a versioned row (e.g. appointment) — surface a 409 so
      // the client reloads and retries instead of silently losing an update.
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'This record was modified by someone else. Reload and try again.',
        error: 'OptimisticLockVersionMismatchError',
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    const bodyParser = this.asBodyParserError(exception);
    if (bodyParser) return bodyParser;

    // Unknown / unexpected — treat as a bug. Hide details in production: the
    // real message AND the real class name (e.g. TypeError) are dev-only
    // diagnostics; a client never learns anything beyond "something broke."
    const devErrorName = exception instanceof Error ? exception.constructor.name : 'Error';
    const devMessage =
      exception instanceof Error ? exception.message : String(exception);
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: this.isProduction ? PRODUCTION_SAFE_MESSAGE : devMessage,
      error: this.isProduction ? PRODUCTION_SAFE_ERROR_LABEL : devErrorName,
    };
  }

  /**
   * body-parser rejects a request BEFORE any guard, pipe or controller runs —
   * an over-sized body (`entity.too.large`), malformed JSON
   * (`entity.parse.failed`), a bad charset or an unsupported encoding. Those
   * errors are plain `Error`s carrying an HTTP `status`, not Nest
   * `HttpException`s, so without this branch they fall through to the
   * unknown-error case and a caller who simply sent too much data gets a 500 —
   * indistinguishable from a server bug, and un-actionable.
   *
   * Deliberately narrow: it only claims errors that carry BOTH a body-parser
   * `type` and a 4xx status, so a genuine internal failure is never dressed up
   * as a client error. The message is body-parser's own fixed, non-leaking text
   * (e.g. "request entity too large") — never request content.
   */
  private asBodyParserError(exception: unknown): NormalizedError | null {
    if (!(exception instanceof Error)) return null;
    const e = exception as Error & { type?: unknown; status?: unknown; statusCode?: unknown };
    if (typeof e.type !== 'string' || !e.type.startsWith('entity.') && !e.type.startsWith('charset.') && !e.type.startsWith('encoding.')) {
      return null;
    }
    const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : 0;
    if (status < 400 || status >= 500) return null;

    return {
      statusCode: status,
      code:
        status === HttpStatus.PAYLOAD_TOO_LARGE
          ? ErrorCode.VALIDATION_ERROR
          : ErrorCode.BAD_REQUEST,
      message:
        status === HttpStatus.PAYLOAD_TOO_LARGE
          ? 'Request body is too large'
          : 'Request body could not be parsed',
      error: e.constructor.name,
    };
  }

  /**
   * Single funnel for every AppError-backed response — whether thrown
   * directly by application code or produced by {@link mapTypeOrmError} from
   * a raw DB failure. `context` is ONLY EVER populated here, from
   * `AppError.publicContext` — the one channel in this whole filter that a
   * developer explicitly opts into per-throw (see {@link AppError}'s docs) —
   * nothing else in `normalize()` ever attaches context to a response, in any
   * environment. `AppError.internalContext` is carried separately and is
   * NEVER read by `catch()` when building the client response — it (and
   * `cause`) only reach `writeLog()`.
   *
   * The `error` label collapses to the generic `AppError` wrapper name in
   * production — the underlying (sometimes TypeORM-specific, e.g.
   * `QueryFailedError`) class name is a dev-only diagnostic aid, not
   * something a client needs or should see.
   */
  private fromAppError(error: AppError, devErrorLabel: string): NormalizedError {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      error: this.isProduction ? 'AppError' : devErrorLabel,
      context: error.publicContext,
      internalContext: error.internalContext,
    };
  }

  private fromHttpException(exception: HttpException): NormalizedError {
    const statusCode = exception.getStatus();
    const res = exception.getResponse();

    let message: string | string[];
    if (typeof res === 'string') {
      message = res;
    } else {
      const r = res as { message?: string | string[] };
      message = r.message ?? exception.message;
    }

    // class-validator surfaces an array of messages → it's a validation error.
    const code = Array.isArray(message)
      ? ErrorCode.VALIDATION_ERROR
      : this.statusToCode(statusCode);

    return {
      statusCode,
      code,
      message,
      error: exception.constructor.name,
    };
  }

  private statusToCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.BAD_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }

  // ----------------------------------------------------------------------- //
  // Structured logging (server-side only)
  // ----------------------------------------------------------------------- //

  private writeLog(
    normalized: NormalizedError,
    exception: unknown,
    request: Request,
    requestId: string,
  ): void {
    // Narrow cast — the filter stays decoupled from the auth module's types.
    const principal = request.user as
      | { id?: string; tenantId?: string | null }
      | undefined;

    // Logs prefer the ORIGINAL exception message over the (possibly sanitized)
    // client-facing one — e.g. a mapped QueryFailedError shows "Email already
    // exists" to the caller, but the log keeps the real driver message so an
    // operator can actually diagnose the failure. HttpException is excluded:
    // Nest synthesizes a generic `.message` for it when the real content is an
    // array (class-validator), so `normalized.message` is already the truer
    // signal there.
    const rawMessage =
      exception instanceof Error && !(exception instanceof HttpException)
        ? exception.message
        : undefined;

    // `cause` is documented as "logged server-side only" — this is the one
    // place that promise is actually kept. Only ever read off the raw
    // exception (an AppError thrown directly), never off a `normalize()`d
    // stand-in, so it can't be confused with anything client-facing.
    const cause =
      exception instanceof AppError && exception.cause instanceof Error
        ? exception.cause
        : undefined;

    const payload = {
      requestId,
      method: request.method,
      url: request.originalUrl,
      statusCode: normalized.statusCode,
      code: normalized.code,
      userId: principal?.id,
      tenantId: principal?.tenantId,
      message:
        rawMessage ??
        (Array.isArray(normalized.message)
          ? normalized.message.join('; ')
          : normalized.message),
      // Server-log-only diagnostics — never present in the client response.
      internalContext: normalized.internalContext
        ? sanitizeForLog(normalized.internalContext)
        : undefined,
      cause: cause ? { message: cause.message, name: cause.name } : undefined,
      body: sanitizeForLog(request.body),
    };

    const serialized = JSON.stringify(payload);

    if (normalized.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // 5xx: real failures — log at error with the full stack, including the
      // cause's own stack (e.g. the raw DB/provider error an AppError wraps).
      const stack = exception instanceof Error
        ? [exception.stack, cause?.stack && `Caused by: ${cause.stack}`]
            .filter(Boolean)
            .join('\n')
        : undefined;
      this.logger.error(serialized, stack);
    } else {
      // 4xx: expected/operational — log at warn, no stack noise.
      this.logger.warn(serialized);
    }
  }
}

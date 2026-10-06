import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppError } from '../errors/app-error';
import { normalizeException } from '../errors/error-normalizer';
import type { NormalizedError } from '../errors/error-normalizer';
import { ErrorResponseBody } from '../interfaces/error-response.interface';
import { sanitizeForLog, sanitizeUrlForLog } from '../utils/sanitize.util';
import { scrubText, summarizeBodyForLog } from '../utils/log-scrubber.util';

/** `Retry-After` bounds (seconds). A 429 with no hint falls back to the length of the rate-limit windows in use. */
const RETRY_AFTER_MIN_SECONDS = 1;
const RETRY_AFTER_MAX_SECONDS = 3600;
const RETRY_AFTER_DEFAULT_429_SECONDS = 60;

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

    const normalized = normalizeException(exception, this.isProduction);

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

    const retryAfter = this.retryAfterSeconds(normalized, response);
    if (retryAfter !== undefined) response.setHeader('Retry-After', String(retryAfter));

    response.status(normalized.statusCode).json(body);
  }

  /**
   * `Retry-After` for throttled/unavailable responses, so an integrator can back
   * off precisely instead of guessing.
   *  - never overrides a header something upstream already set (the Nest
   *    throttler sets its own);
   *  - 429 and 503 only;
   *  - the value comes from the error's own client-safe `retryAfterMs` hint when
   *    it has one; a 429 without a hint falls back to a full window; a 503 without
   *    a hint gets NO header (maintenance windows have no honest estimate).
   */
  private retryAfterSeconds(
    normalized: NormalizedError,
    response: Response,
  ): number | undefined {
    const status = normalized.statusCode;
    if (status !== HttpStatus.TOO_MANY_REQUESTS && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      return undefined;
    }
    if (response.getHeader('Retry-After') !== undefined) return undefined;

    const hintMs = normalized.context?.retryAfterMs;
    if (typeof hintMs === 'number' && Number.isFinite(hintMs) && hintMs > 0) {
      return Math.min(
        RETRY_AFTER_MAX_SECONDS,
        Math.max(RETRY_AFTER_MIN_SECONDS, Math.ceil(hintMs / 1000)),
      );
    }
    return status === HttpStatus.TOO_MANY_REQUESTS
      ? RETRY_AFTER_DEFAULT_429_SECONDS
      : undefined;
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
      // Query string may carry a free-text search term (e.g. a customer's
      // national ID) — redact those values before they reach the log.
      url: sanitizeUrlForLog(request.originalUrl),
      statusCode: normalized.statusCode,
      code: normalized.code,
      userId: principal?.id,
      tenantId: principal?.tenantId,
      // The raw driver/provider message can quote row values or echo a
      // recipient ("invalid input syntax for type uuid: '0501234567'") — scrub
      // by shape before it is written (residency plan P7).
      message: scrubText(
        rawMessage ??
          (Array.isArray(normalized.message)
            ? normalized.message.join('; ')
            : normalized.message),
      ),
      // Server-log-only diagnostics — never present in the client response.
      internalContext: normalized.internalContext
        ? sanitizeForLog(normalized.internalContext)
        : undefined,
      cause: cause
        ? { message: scrubText(cause.message), name: cause.name }
        : undefined,
      // Shape only (field names, types, lengths): a request body is whatever a
      // patient or clinician typed, so its TEXT is never logged.
      body: summarizeBodyForLog(request.body),
    };

    const serialized = JSON.stringify(payload);

    if (normalized.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // 5xx: real failures — log at error with the full stack, including the
      // cause's own stack (e.g. the raw DB/provider error an AppError wraps).
      const stack =
        exception instanceof Error
          ? scrubText(
              [exception.stack, cause?.stack && 'Caused by: ' + cause.stack]
                .filter(Boolean)
                .join('\n'),
            )
          : undefined;
      this.logger.error(serialized, stack);
    } else {
      // 4xx: expected/operational — log at warn, no stack noise.
      this.logger.warn(serialized);
    }
  }
}

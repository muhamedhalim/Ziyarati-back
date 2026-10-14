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
import { queryKeysForLog, sanitizeForLog } from '../utils/sanitize.util';
import { scrubText, summarizeBodyForLog } from '../utils/log-scrubber.util';
import { formatClientIp, routeTemplate } from '../logging/http-access-log';
import { LOG_EVENT } from '../logging/log-events';

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

  /**
   * The ONE log line for a failed request (the access log separately records
   * that the request happened). This filter owns the failure: controllers and
   * services that rethrow must not log the same error again.
   */
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

    const status = normalized.statusCode;
    const route = routeTemplate(request);
    const classification = classifyFailure(status, request.method, route);
    const isServerError = status >= HttpStatus.INTERNAL_SERVER_ERROR;

    // The raw driver/provider message can quote row values or echo a
    // recipient ("invalid input syntax for type uuid: '0501234567'") — scrub
    // by shape before it is written (residency plan P7).
    const message = scrubText(
      withoutRawUrl(
        rawMessage ??
          (Array.isArray(normalized.message)
            ? normalized.message.join('; ')
            : normalized.message),
        request.method,
        route,
      ),
    );

    const payload: Record<string, unknown> = {
      event: classification.event,
      message,
      request_id: requestId,
      method: request.method,
      route,
      // LSA-06: never the raw URL. Path parameters (`/by-phone/<number>`) and
      // query VALUES (search terms, names, phones) are whatever the caller
      // typed; `route` is the matched template and `query_keys` the parameter
      // NAMES only — enough to see which filters were used.
      query_keys: queryKeysForLog(request.originalUrl),
      status,
      code: normalized.code,
      user_id: principal?.id,
      tenant_id: principal?.tenantId ?? undefined,
      // Server-log-only diagnostics — never present in the client response.
      internal_context: normalized.internalContext
        ? sanitizeForLog(normalized.internalContext)
        : undefined,
      // Shape only (field names, types, lengths): a request body is whatever a
      // patient or clinician typed, so its TEXT is never logged.
      body_shape: summarizeBodyForLog(request.body),
      error: {
        type: exception instanceof Error ? exception.name : 'NonError',
        message,
        // 5xx only: the full stack, including the cause's own stack (e.g. the
        // raw DB/provider error an AppError wraps). 4xx carry no stack noise.
        stack:
          isServerError && exception instanceof Error
            ? scrubText(
                [exception.stack, cause?.stack && 'Caused by: ' + cause.stack]
                  .filter(Boolean)
                  .join('\n'),
              )
            : undefined,
        cause: cause
          ? { type: cause.name, message: scrubText(cause.message) }
          : undefined,
      },
    };
    // Security events carry the source address (trusted-proxy aware `req.ip`)
    // so bursts can be attributed and alerted on; ordinary failures do not.
    if (classification.security) {
      // LSA-08: the /24 (/48) network, not the full address joined to a user
      // and clinic. Browser traffic arrives through the Vercel rewrite, so for
      // it this is Vercel's shared egress network, not the end user's.
      payload.client_ip = formatClientIp(request.ip, 'truncated');
      if (classification.reason) payload.reason = classification.reason;
    }

    if (isServerError) this.logger.error(payload);
    else if (classification.level === 'info') this.logger.log(payload);
    else this.logger.warn(payload);
  }
}

/**
 * Nest's router 404 is `Cannot GET /the/raw/path?with=query` — the caller's
 * URL inside the MESSAGE, which bypassed the `path` redaction (LSA-06). The
 * method and route template carry the same diagnostic without the values.
 */
const RAW_URL_MESSAGE_RE = /^Cannot [A-Z]{3,7} \S*/;

function withoutRawUrl(message: string, method: string, route: string): string {
  return RAW_URL_MESSAGE_RE.test(message)
    ? message.replace(RAW_URL_MESSAGE_RE, `Cannot ${method} ${route}`)
    : message;
}

interface FailureClassification {
  event: string;
  level: 'info' | 'warn' | 'error';
  security: boolean;
  reason?: string;
}

const LOGIN_ROUTE_RE = /\/auth\/login$/;
const REFRESH_ROUTE_RE = /\/auth\/refresh$/;
const BOOKING_ROUTE_RE = /\/(?:appointments|public\/booking\/confirm)$/;
const PAYMENT_WEBHOOK_ROUTE_RE = /\/payments\/webhooks(?:\/|$)/;
const PAYMENT_ROUTE_RE = /\/(?:payments|refunds|payment-links|invoices)(?:\/|$)/;
const WEBHOOK_ROUTE_RE = /\/webhooks?(?:\/|$)/;

/**
 * Maps a failed request onto ONE stable event name. Security outcomes (401,
 * 403, 429, failed logins) are classified first so they are searchable and
 * alertable on their own; then the business flows the incident playbook cares
 * about (bookings, payments, webhooks); everything else is a generic
 * request failure. The login reason is the error CODE class only — it never
 * says whether the account exists (no user enumeration through logs).
 */
export function classifyFailure(
  status: number,
  method: string,
  route: string,
): FailureClassification {
  const serverError = status >= HttpStatus.INTERNAL_SERVER_ERROR;
  if (LOGIN_ROUTE_RE.test(route) && !serverError) {
    const reason =
      status === HttpStatus.TOO_MANY_REQUESTS
        ? 'rate_limited'
        : status === HttpStatus.UNAUTHORIZED
          ? 'invalid_credentials'
          : status === HttpStatus.FORBIDDEN
            ? 'forbidden'
            : 'rejected';
    return { event: LOG_EVENT.AUTH_LOGIN_FAILED, level: 'warn', security: true, reason };
  }
  if (REFRESH_ROUTE_RE.test(route) && status === HttpStatus.UNAUTHORIZED) {
    return { event: LOG_EVENT.AUTH_REFRESH_FAILED, level: 'warn', security: true, reason: 'invalid_refresh_token' };
  }
  if (status === HttpStatus.UNAUTHORIZED) {
    return { event: LOG_EVENT.AUTH_AUTHENTICATION_FAILED, level: 'warn', security: true, reason: 'unauthenticated' };
  }
  if (status === HttpStatus.FORBIDDEN) {
    return { event: LOG_EVENT.AUTH_AUTHORIZATION_DENIED, level: 'warn', security: true, reason: 'forbidden' };
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return { event: LOG_EVENT.HTTP_RATE_LIMITED, level: 'warn', security: true, reason: 'rate_limited' };
  }
  const level = serverError ? 'error' : 'warn';
  if (method === 'POST' && BOOKING_ROUTE_RE.test(route)) {
    return { event: LOG_EVENT.APPOINTMENT_BOOKING_FAILED, level, security: false };
  }
  if (PAYMENT_WEBHOOK_ROUTE_RE.test(route)) {
    return { event: LOG_EVENT.PAYMENT_WEBHOOK_FAILED, level, security: false };
  }
  if (PAYMENT_ROUTE_RE.test(route)) {
    return { event: LOG_EVENT.PAYMENT_PROCESSING_FAILED, level, security: false };
  }
  if (WEBHOOK_ROUTE_RE.test(route)) {
    return { event: LOG_EVENT.WEBHOOK_PROCESSING_FAILED, level, security: false };
  }
  if (serverError) {
    return { event: LOG_EVENT.HTTP_REQUEST_FAILED, level: 'error', security: false };
  }
  // A path that matched no route (scanners, typos) is routine noise, not an anomaly.
  if (status === HttpStatus.NOT_FOUND && route === 'unmatched') {
    return { event: LOG_EVENT.HTTP_REQUEST_REJECTED, level: 'info', security: false };
  }
  return { event: LOG_EVENT.HTTP_REQUEST_REJECTED, level: 'warn', security: false };
}

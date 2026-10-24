import { HttpException, HttpStatus } from '@nestjs/common';
import {
  EntityNotFoundError,
  OptimisticLockVersionMismatchError,
  QueryFailedError,
} from 'typeorm';

import { AppError } from './app-error';
import { ErrorCode } from './error-code';
import { mapTypeOrmError } from './typeorm-error.mapper';

export interface NormalizedError {
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
 * Reduces any thrown value to the single canonical error shape
 * (`AllExceptionsFilter`'s HTTP contract). Extracted as a pure function (no
 * request/response dependency) so the AI realtime gateway can normalize
 * `ai:error` emissions through the exact same rules the REST path already
 * uses, rather than duplicating them (AI-010, Principle V).
 */
export function normalizeException(
  exception: unknown,
  isProduction: boolean,
): NormalizedError {
  if (exception instanceof AppError) {
    return fromAppError(exception, 'AppError', isProduction);
  }

  if (exception instanceof QueryFailedError) {
    // mapTypeOrmError() always returns an AppError, so this funnels through
    // the exact same client-safe-context rule as a directly-thrown AppError.
    return fromAppError(
      mapTypeOrmError(exception),
      'QueryFailedError',
      isProduction,
    );
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
    return fromHttpException(exception);
  }

  const bodyParser = asBodyParserError(exception);
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
    message: isProduction ? PRODUCTION_SAFE_MESSAGE : devMessage,
    error: isProduction ? PRODUCTION_SAFE_ERROR_LABEL : devErrorName,
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
function asBodyParserError(exception: unknown): NormalizedError | null {
  if (!(exception instanceof Error)) return null;
  const e = exception as Error & {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    errno?: unknown;
    expose?: unknown;
  };
  const hasBodyParserType =
    typeof e.type === 'string' &&
    (e.type.startsWith('entity.') || e.type.startsWith('charset.') || e.type.startsWith('encoding.'));
  // A corrupt compressed body (bad gzip/deflate/brotli stream) reaches us as the raw zlib error, which
  // body-parser stamps with `status: 400, expose: true` but NO `type` (`code: 'Z_DATA_ERROR'`, brotli's
  // `ERR_…`, negative `errno`). Without this it fell through to the 500 branch: a client-controlled input
  // fault logged and counted as a server error. All three markers must be present, so an unrelated
  // internal error that merely has a `code` is never dressed up as a client error.
  const isDecompressionFailure =
    e.expose === true &&
    typeof e.code === 'string' &&
    /^(Z_[A-Z_]+|ERR_[A-Z0-9_]+)$/.test(e.code) &&
    typeof e.errno === 'number' &&
    e.errno < 0;
  if (!hasBodyParserType && !isDecompressionFailure) {
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
 * `AppError.publicContext` — the one channel a developer explicitly opts
 * into per-throw (see {@link AppError}'s docs) — nothing else in
 * `normalizeException()` ever attaches context to a response, in any
 * environment. `AppError.internalContext` is carried separately and is
 * NEVER read when building the client response — it (and `cause`) only
 * reach the caller's own server-side logging.
 *
 * The `error` label collapses to the generic `AppError` wrapper name in
 * production — the underlying (sometimes TypeORM-specific, e.g.
 * `QueryFailedError`) class name is a dev-only diagnostic aid, not
 * something a client needs or should see.
 */
function fromAppError(
  error: AppError,
  devErrorLabel: string,
  isProduction: boolean,
): NormalizedError {
  return {
    statusCode: error.statusCode,
    code: error.code,
    message: error.message,
    error: isProduction ? 'AppError' : devErrorLabel,
    context: error.publicContext,
    internalContext: error.internalContext,
  };
}

function fromHttpException(exception: HttpException): NormalizedError {
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
    : statusToCode(statusCode);

  return {
    statusCode,
    code,
    message,
    error: exception.constructor.name,
  };
}

function statusToCode(status: number): ErrorCode {
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

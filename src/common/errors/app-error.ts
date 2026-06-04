import { HttpStatus } from '@nestjs/common';
import { ERROR_CODE_METADATA, ErrorCode } from './error-code';

export interface AppErrorOptions {
  /** Override the default message for the code (must stay client-safe). */
  message?: string;
  /** Override the default HTTP status for the code. */
  status?: HttpStatus;
  /**
   * Client-safe metadata returned in the response `context` field
   * (e.g. `{ field: 'email' }`). NEVER put secrets or internal details here.
   */
  context?: Record<string, unknown>;
  /** The underlying error (logged server-side only, never sent to client). */
  cause?: unknown;
}

/**
 * Base application error. Service-level code throws these instead of raw
 * HttpExceptions, so every failure carries a stable machine-readable `code`,
 * a known HTTP status, and a client-safe message.
 *
 * `isOperational = true` marks it as an expected/handled error (vs. an
 * unforeseen bug), which the filter uses to decide log severity.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: HttpStatus;
  readonly context?: Record<string, unknown>;
  readonly isOperational = true;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const meta = ERROR_CODE_METADATA[code];
    super(options.message ?? meta.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.status ?? meta.status;
    this.context = options.context;

    // Keep the stack pointing at the throw site, not this constructor.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  // ── Convenience factories for the most common cases ────────────────────
  static notFound(code: ErrorCode = ErrorCode.NOT_FOUND, message?: string) {
    return new AppError(code, { message });
  }

  static conflict(code: ErrorCode = ErrorCode.CONFLICT, message?: string) {
    return new AppError(code, { message });
  }

  static forbidden(code: ErrorCode = ErrorCode.FORBIDDEN, message?: string) {
    return new AppError(code, { message });
  }
}

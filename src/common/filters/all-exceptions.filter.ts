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
  /** Client-safe metadata. */
  context?: Record<string, unknown>;
}

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
      return {
        statusCode: exception.statusCode,
        code: exception.code,
        message: exception.message,
        error: 'AppError',
        context: exception.context,
      };
    }

    if (exception instanceof QueryFailedError) {
      const mapped = mapTypeOrmError(exception);
      return {
        statusCode: mapped.statusCode,
        code: mapped.code,
        message: mapped.message,
        error: 'QueryFailedError',
        context: mapped.context,
      };
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

    // Unknown / unexpected — treat as a bug. Hide details in production.
    const error = exception instanceof Error ? exception.constructor.name : 'Error';
    const devMessage =
      exception instanceof Error ? exception.message : String(exception);
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: this.isProduction ? 'An unexpected error occurred' : devMessage,
      error,
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

    const payload = {
      requestId,
      method: request.method,
      url: request.originalUrl,
      statusCode: normalized.statusCode,
      code: normalized.code,
      userId: principal?.id,
      tenantId: principal?.tenantId,
      message: Array.isArray(normalized.message)
        ? normalized.message.join('; ')
        : normalized.message,
      body: sanitizeForLog(request.body),
    };

    const serialized = JSON.stringify(payload);

    if (normalized.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // 5xx: real failures — log at error with the full stack.
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(serialized, stack);
    } else {
      // 4xx: expected/operational — log at warn, no stack noise.
      this.logger.warn(serialized);
    }
  }
}

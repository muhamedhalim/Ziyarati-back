import { HttpStatus } from '@nestjs/common';

/**
 * Machine-readable error codes. These are part of the public API contract:
 * clients branch on `code`, not on `message` (which may be localized/changed).
 * Never rename a code — add a new one.
 */
export enum ErrorCode {
  // ── Generic ──────────────────────────────────────────────────────────
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNPROCESSABLE_ENTITY = 'UNPROCESSABLE_ENTITY',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  RATE_LIMITED = 'RATE_LIMITED',
  /**
   * A dependency required to admit the request safely is unavailable, so the
   * request was REJECTED rather than admitted unchecked (fail-closed). Always
   * retryable — the client should back off and retry.
   */
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // ── Authentication ───────────────────────────────────────────────────
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN = 'INVALID_REFRESH_TOKEN',
  INVALID_RESET_TOKEN = 'INVALID_RESET_TOKEN',
  USER_INACTIVE = 'USER_INACTIVE',

  // ── RBAC / authorization ─────────────────────────────────────────────
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  ROLE_NOT_FOUND = 'ROLE_NOT_FOUND',
  ROLE_ALREADY_EXISTS = 'ROLE_ALREADY_EXISTS',
  ROLE_IMMUTABLE = 'ROLE_IMMUTABLE',
  PERMISSION_NOT_FOUND = 'PERMISSION_NOT_FOUND',
  ROLE_ASSIGNMENT_EXISTS = 'ROLE_ASSIGNMENT_EXISTS',
  ROLE_ASSIGNMENT_NOT_FOUND = 'ROLE_ASSIGNMENT_NOT_FOUND',

  // ── Users / tenants ──────────────────────────────────────────────────
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS',
  TENANT_NOT_FOUND = 'TENANT_NOT_FOUND',

  // ── Persistence (mapped from TypeORM, never raw SQL) ─────────────────
  UNIQUE_VIOLATION = 'UNIQUE_VIOLATION',
  FOREIGN_KEY_VIOLATION = 'FOREIGN_KEY_VIOLATION',
  NOT_NULL_VIOLATION = 'NOT_NULL_VIOLATION',
  DATABASE_ERROR = 'DATABASE_ERROR',

  // ── Billing upgrade requests ──────────────────────────────────────────
  DUPLICATE_ACTIVE_REQUEST = 'DUPLICATE_ACTIVE_REQUEST',
  INVALID_UPGRADE_METRIC = 'INVALID_UPGRADE_METRIC',
  INVALID_REQUEST_STATUS = 'INVALID_REQUEST_STATUS',
  REQUEST_NOT_QUOTED = 'REQUEST_NOT_QUOTED',
  QUOTE_EXPIRED = 'QUOTE_EXPIRED',
}

export interface ErrorCodeMeta {
  /** Default HTTP status for this code. */
  status: HttpStatus;
  /** Default, client-safe message. Overridable per-throw. */
  message: string;
}

/**
 * Default HTTP status + safe message for every code. Messages here are public —
 * they must never contain internal details (SQL, table names, stack info).
 */
export const ERROR_CODE_METADATA: Record<ErrorCode, ErrorCodeMeta> = {
  [ErrorCode.INTERNAL_ERROR]: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'An unexpected error occurred',
  },
  [ErrorCode.VALIDATION_ERROR]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Validation failed',
  },
  [ErrorCode.BAD_REQUEST]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Bad request',
  },
  [ErrorCode.NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Resource not found',
  },
  [ErrorCode.CONFLICT]: {
    status: HttpStatus.CONFLICT,
    message: 'Resource conflict',
  },
  [ErrorCode.UNPROCESSABLE_ENTITY]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'The request was well-formed but cannot be processed',
  },
  [ErrorCode.UNAUTHORIZED]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Authentication required',
  },
  [ErrorCode.FORBIDDEN]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Access denied',
  },
  [ErrorCode.RATE_LIMITED]: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many requests',
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Service temporarily unavailable — please retry',
  },

  [ErrorCode.INVALID_CREDENTIALS]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Invalid email or password',
  },
  [ErrorCode.INVALID_REFRESH_TOKEN]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Invalid or expired refresh token',
  },
  [ErrorCode.INVALID_RESET_TOKEN]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Invalid or expired reset token',
  },
  [ErrorCode.USER_INACTIVE]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'This account is inactive',
  },

  [ErrorCode.PERMISSION_DENIED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'You do not have permission to perform this action',
  },
  [ErrorCode.ROLE_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Role not found',
  },
  [ErrorCode.ROLE_ALREADY_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'A role with this slug already exists',
  },
  [ErrorCode.ROLE_IMMUTABLE]: {
    status: HttpStatus.FORBIDDEN,
    message: 'This role cannot be modified',
  },
  [ErrorCode.PERMISSION_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Permission not found',
  },
  [ErrorCode.ROLE_ASSIGNMENT_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'User already has this role',
  },
  [ErrorCode.ROLE_ASSIGNMENT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Role assignment not found',
  },

  [ErrorCode.USER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'User not found',
  },
  [ErrorCode.EMAIL_ALREADY_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'Email already exists in this tenant',
  },
  [ErrorCode.TENANT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Tenant not found',
  },

  [ErrorCode.UNIQUE_VIOLATION]: {
    status: HttpStatus.CONFLICT,
    message: 'A record with these details already exists',
  },
  [ErrorCode.FOREIGN_KEY_VIOLATION]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Invalid reference to a related resource',
  },
  [ErrorCode.NOT_NULL_VIOLATION]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A required field is missing',
  },
  [ErrorCode.DATABASE_ERROR]: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'A database error occurred',
  },

  [ErrorCode.DUPLICATE_ACTIVE_REQUEST]: {
    status: HttpStatus.CONFLICT,
    message: 'An active upgrade request already exists for this feature or usage limit',
  },
  [ErrorCode.INVALID_UPGRADE_METRIC]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This feature or usage metric cannot be requested',
  },
  [ErrorCode.INVALID_REQUEST_STATUS]: {
    status: HttpStatus.CONFLICT,
    message: 'This request cannot be modified from its current status',
  },
  [ErrorCode.REQUEST_NOT_QUOTED]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This request has not been quoted yet',
  },
  [ErrorCode.QUOTE_EXPIRED]: {
    status: HttpStatus.CONFLICT,
    message: 'This quote has expired — ask the platform to re-quote the request',
  },
};

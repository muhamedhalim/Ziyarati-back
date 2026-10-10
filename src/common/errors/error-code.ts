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

  // ── File uploads ─────────────────────────────────────────────────────
  /**
   * Upload-specific codes. They exist so a client can say something USEFUL and
   * localized about a rejected file instead of rendering a developer string:
   * every upload failure used to be a bare `BAD_REQUEST` carrying English
   * prose, while the frontend's `app/lib/api-error.ts` has long DECLARED file
   * codes the backend never actually emitted.
   *
   * Thrown by the spreadsheet import paths (`xlsx-row-parser.ts`). The older
   * `/uploads` routes keep emitting `BAD_REQUEST`.
   */
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE = 'UNSUPPORTED_FILE_TYPE',
  /** Declared type and actual bytes disagree (magic bytes), or the file is corrupt. */
  FILE_CONTENT_MISMATCH = 'FILE_CONTENT_MISMATCH',

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

  // ── Subscription grace lifecycle (FND-031) ────────────────────────────
  /** The subscription's grace window has elapsed with no settlement — new billable/usage-increasing actions are refused; read access is unaffected. */
  SUBSCRIPTION_GRACE_EXPIRED = 'SUBSCRIPTION_GRACE_EXPIRED',
  /** Tenant has no usable access path at all (no paid subscription, no free-access override, platform not in free mode) — the broad gate, blocking the whole workspace rather than just billable actions. */
  NO_ACTIVE_SUBSCRIPTION = 'NO_ACTIVE_SUBSCRIPTION',

  // ── Services (FND-012) ─────────────────────────────────────────────────
  /** A VARIABLE-priced service was selected for booking — no booking-time pricing mechanism exists yet (AD-11: blocked, not built); a zero price is never snapshotted. */
  VARIABLE_PRICING_UNSUPPORTED = 'VARIABLE_PRICING_UNSUPPORTED',

  // ── Scheduling / booking ──────────────────────────────────────────────
  /**
   * The availability engine refused the requested window for the selected
   * staff member — outside working hours, on time off, a holiday, inside a
   * blocked period, the staff member is not bookable, or they already have an
   * appointment that overlaps. `context.reasonCodes` (a `BookabilityReason[]`)
   * says which, so a client can render a specific, localized message instead of
   * branching on prose.
   *
   * Distinct from {@link SLOT_ALREADY_BOOKED}: this is the PRE-CHECK refusing a
   * window that was never bookable, not a lost race.
   */
  STAFF_NOT_AVAILABLE = 'STAFF_NOT_AVAILABLE',
  /**
   * The window WAS bookable when checked, but a concurrent request committed
   * first — the `appointments_no_overlap` exclusion constraint rejected this
   * insert (SQLSTATE 23P01). Always retryable against a different time: the
   * client should refresh the available slots and re-pick.
   */
  SLOT_ALREADY_BOOKED = 'SLOT_ALREADY_BOOKED',

  // ── Patient queue (Spec 014, US10) ─────────────────────────────────────
  /**
   * A queue entry's `start` action was refused because the underlying
   * appointment is still `PENDING_PAYMENT` (FR-Q007a/FR-Q007c). The queue
   * never confirms an appointment implicitly — confirm it through the
   * existing `POST /appointments/:id/status` route, then retry `start`.
   * `context.requires` is always `'CONFIRM_APPOINTMENT'`.
   */
  AWAITING_CONFIRMATION = 'AWAITING_CONFIRMATION',

  // ── Sales Staff Management (platform) ──────────────────────────────────
  /** The id is not a live platform user holding `platform_sales`. Also returned for a tenant user, a super admin or a deleted user — existence is never leaked. */
  SALES_EMPLOYEE_NOT_FOUND = 'SALES_EMPLOYEE_NOT_FOUND',
  /** The employee exists but is deactivated — nothing new may be assigned to them. */
  SALES_EMPLOYEE_INACTIVE = 'SALES_EMPLOYEE_INACTIVE',
  /** The clinic already has an active sales owner (`UQ_sales_assignment_active_tenant`). */
  SALES_CLINIC_ALREADY_ASSIGNED = 'SALES_CLINIC_ALREADY_ASSIGNED',
  /** The assignment id does not exist (or does not belong to the employee in the route). */
  SALES_ASSIGNMENT_NOT_FOUND = 'SALES_ASSIGNMENT_NOT_FOUND',
  /** No target exists for that employee / month / metric. */
  SALES_TARGET_NOT_FOUND = 'SALES_TARGET_NOT_FOUND',
  /** Someone else changed the target since the caller loaded it (`expectedVersion` mismatch, or a concurrent create). */
  SALES_TARGET_VERSION_CONFLICT = 'SALES_TARGET_VERSION_CONFLICT',
  /** The target's bonus is approved (or the month is closed and the request tries to delete it) — it can no longer be changed. */
  SALES_TARGET_LOCKED = 'SALES_TARGET_LOCKED',
  /** Writing to a closed month needs a written reason. */
  SALES_REASON_REQUIRED = 'SALES_REASON_REQUIRED',
  /** A live (approved or paid) bonus already exists for this target — approving twice, or approving a locked target. */
  SALES_BONUS_EXISTS = 'SALES_BONUS_EXISTS',
  /** A bonus can only be approved once its month has closed. */
  SALES_PERIOD_NOT_CLOSED = 'SALES_PERIOD_NOT_CLOSED',
  /** The target has no bonus rule, so there is nothing to approve. */
  SALES_BONUS_NO_RULE = 'SALES_BONUS_NO_RULE',
  /** The bonus id does not exist (or belongs to a different employee than the one in the route). */
  SALES_BONUS_NOT_FOUND = 'SALES_BONUS_NOT_FOUND',
  /** The bonus is not in the state the action needs (e.g. marking a void or already-paid bonus as paid). */
  SALES_BONUS_STATE_CONFLICT = 'SALES_BONUS_STATE_CONFLICT',
  /** The activity id does not exist, was deleted, or belongs to a different employee than the one in the route. */
  SALES_ACTIVITY_NOT_FOUND = 'SALES_ACTIVITY_NOT_FOUND',
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

  [ErrorCode.FILE_TOO_LARGE]: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'File is larger than the allowed maximum',
  },
  [ErrorCode.UNSUPPORTED_FILE_TYPE]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This file type is not supported',
  },
  [ErrorCode.FILE_CONTENT_MISMATCH]: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'File content does not match its declared type, or the file is corrupted',
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
    // D7 — email uniqueness is enforced globally (any live user, any tenant),
    // not per-tenant; the message must not imply a narrower scope than the
    // actual rule.
    status: HttpStatus.CONFLICT,
    message: 'This email is already in use',
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
    message:
      'An active upgrade request already exists for this feature or usage limit',
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
    message:
      'This quote has expired — ask the platform to re-quote the request',
  },

  [ErrorCode.SUBSCRIPTION_GRACE_EXPIRED]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'Your subscription grace period has ended. Renew or contact support to continue this action — your existing data remains fully accessible.',
  },
  [ErrorCode.NO_ACTIVE_SUBSCRIPTION]: {
    status: HttpStatus.FORBIDDEN,
    message:
      'Your clinic account has been approved, but you do not have an active subscription yet. Choose a paid plan to start using the platform.',
  },

  [ErrorCode.VARIABLE_PRICING_UNSUPPORTED]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'This service uses variable pricing, which cannot be booked online yet. Please arrange this booking directly with the clinic.',
  },

  [ErrorCode.STAFF_NOT_AVAILABLE]: {
    status: HttpStatus.CONFLICT,
    message: 'Staff member is not available at this time.',
  },
  [ErrorCode.SLOT_ALREADY_BOOKED]: {
    status: HttpStatus.CONFLICT,
    message:
      'This time slot was just booked for the selected staff member. Please choose another time.',
  },

  [ErrorCode.AWAITING_CONFIRMATION]: {
    status: HttpStatus.CONFLICT,
    message:
      'This appointment is still awaiting payment confirmation and cannot be started yet.',
  },

  [ErrorCode.SALES_EMPLOYEE_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Sales employee not found',
  },
  [ErrorCode.SALES_EMPLOYEE_INACTIVE]: {
    status: HttpStatus.CONFLICT,
    message: 'This sales employee is deactivated',
  },
  [ErrorCode.SALES_CLINIC_ALREADY_ASSIGNED]: {
    status: HttpStatus.CONFLICT,
    message: 'This clinic is already assigned to a sales employee',
  },
  [ErrorCode.SALES_ASSIGNMENT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Sales assignment not found',
  },
  [ErrorCode.SALES_TARGET_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Sales target not found',
  },
  [ErrorCode.SALES_TARGET_VERSION_CONFLICT]: {
    status: HttpStatus.CONFLICT,
    message: 'This target was changed by someone else. Reload it and try again.',
  },
  [ErrorCode.SALES_TARGET_LOCKED]: {
    status: HttpStatus.CONFLICT,
    message: 'This target is locked and can no longer be changed',
  },
  [ErrorCode.SALES_REASON_REQUIRED]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'A reason is required for this change',
  },
  [ErrorCode.SALES_BONUS_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'A bonus has already been approved for this target',
  },
  [ErrorCode.SALES_PERIOD_NOT_CLOSED]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'A bonus can only be approved after its month has closed',
  },
  [ErrorCode.SALES_BONUS_NO_RULE]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This target has no bonus rule, so there is nothing to approve',
  },
  [ErrorCode.SALES_BONUS_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Bonus not found',
  },
  [ErrorCode.SALES_BONUS_STATE_CONFLICT]: {
    status: HttpStatus.CONFLICT,
    message: 'This bonus is no longer in a state that allows this action',
  },
  [ErrorCode.SALES_ACTIVITY_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Sales activity not found',
  },
};

/**
 * The single, canonical error shape returned by every endpoint in the system.
 */
export interface ErrorResponseBody {
  /** HTTP status code. */
  statusCode: number;
  /** Originating error class name (e.g. "AppError", "QueryFailedError"). */
  error: string;
  /** Human-readable message, or an array of messages for validation errors. */
  message: string | string[];
  /** Stable, machine-readable error code clients can branch on. */
  code: string;
  /** Request path that produced the error. */
  path: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Correlation id, also returned in the `X-Request-Id` header. */
  requestId: string;
  /** Optional client-safe metadata (validation details, field names, …). */
  context?: Record<string, unknown>;
}

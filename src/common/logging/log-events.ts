/**
 * Stable, machine-searchable event names (the `event` field of every log line).
 *
 * Convention: `<domain>.<subject>.<outcome>` — lower_snake segments joined by
 * dots, past tense for outcomes (`succeeded`, `failed`, `completed`,
 * `denied`). Names are an API for whoever writes queries, alarms and
 * dashboards: never rename one in place — add the new name, migrate the
 * queries, then retire the old one.
 *
 * Lines written through a plain `new Logger(ctx).log('text')` call have no
 * explicit event; the logger files them under `<context_snake>.log` (for
 * example `queue_monitor.log`) so they stay groupable without every one of the
 * ~250 existing call sites having to change.
 */
export const LOG_EVENT = {
  // Process lifecycle
  APP_STARTUP_COMPLETED: 'app.startup.completed',
  APP_SHUTDOWN_STARTED: 'app.shutdown.started',
  APP_SHUTDOWN_COMPLETED: 'app.shutdown.completed',
  APP_SHUTDOWN_FAILED: 'app.shutdown.failed',
  APP_HEARTBEAT: 'app.heartbeat',
  PROCESS_UNCAUGHT_EXCEPTION: 'process.uncaught_exception',
  PROCESS_UNHANDLED_REJECTION: 'process.unhandled_rejection',

  // HTTP
  HTTP_REQUEST_COMPLETED: 'http.request.completed',
  HTTP_REQUEST_FAILED: 'http.request.failed',
  HTTP_REQUEST_REJECTED: 'http.request.rejected',
  HTTP_RATE_LIMITED: 'http.rate_limited',

  // Authentication / authorization
  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT_SUCCEEDED: 'auth.logout.succeeded',
  AUTH_AUTHENTICATION_FAILED: 'auth.authentication.failed',
  AUTH_AUTHORIZATION_DENIED: 'auth.authorization.denied',
  AUTH_REFRESH_FAILED: 'auth.refresh.failed',
  AUTH_REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
  AUTH_PASSWORD_RESET_REQUESTED: 'auth.password_reset.requested',
  AUTH_PASSWORD_RESET_COMPLETED: 'auth.password_reset.completed',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',
  AUTH_REGISTRATION_SUCCEEDED: 'auth.registration.succeeded',
  AUTH_API_KEY_CHANGED: 'auth.api_key.changed',
  AUTH_ROLE_PERMISSIONS_CHANGED: 'auth.role_permissions.changed',

  // Appointments
  APPOINTMENT_BOOKING_SUCCEEDED: 'appointment.booking.succeeded',
  APPOINTMENT_BOOKING_FAILED: 'appointment.booking.failed',
  APPOINTMENT_STATUS_CHANGED: 'appointment.status.changed',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',

  // Payments
  PAYMENT_STATE_CHANGED: 'payment.state.changed',
  PAYMENT_PROCESSING_FAILED: 'payment.processing.failed',
  PAYMENT_REFUND_RECORDED: 'payment.refund.recorded',
  PAYMENT_WEBHOOK_FAILED: 'payment.webhook.failed',

  // Integrations
  WEBHOOK_PROCESSING_FAILED: 'webhook.processing.failed',
  PROVIDER_REQUEST_COMPLETED: 'provider.request.completed',
  PROVIDER_REQUEST_FAILED: 'provider.request.failed',
  WHATSAPP_MESSAGE_FAILED: 'whatsapp.message.failed',
  AI_REQUEST_FAILED: 'ai.request.failed',
  EMAIL_SEND_FAILED: 'email.send.failed',

  // Background jobs
  JOB_PROCESSING_STARTED: 'job.processing.started',
  JOB_PROCESSING_COMPLETED: 'job.processing.completed',
  JOB_PROCESSING_RETRY_SCHEDULED: 'job.processing.retry_scheduled',
  JOB_PROCESSING_FAILED: 'job.processing.failed',
  JOB_PROCESSING_DEFERRED: 'job.processing.deferred',
  JOB_STALLED: 'job.stalled',
  QUEUE_DLQ_DEPTH_HIGH: 'queue.dlq.depth_high',

  // Database
  DATABASE_OPERATION_FAILED: 'database.operation.failed',
  DATABASE_QUERY_FAILED: 'database.query.failed',
  DATABASE_QUERY_SLOW: 'database.query.slow',
} as const;

export type LogEventName = (typeof LOG_EVENT)[keyof typeof LOG_EVENT];

/** `QueueMonitor` → `queue_monitor`; anything unusable → `app`. */
export function contextToEventPrefix(context: string | undefined): string {
  if (!context) return 'app';
  const snake = context
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  return snake || 'app';
}

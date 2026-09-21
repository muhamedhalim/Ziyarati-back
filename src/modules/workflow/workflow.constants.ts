import { APPOINTMENT_EVENT } from '../../events/appointment.events';
import { CUSTOMER_EVENT } from '../../events/customer.events';
import { PAYMENT_EVENT } from '../../events/payment.events';
import { SUBSCRIPTION_EVENT } from '../../events/subscription.events';

/**
 * The domain events a workflow can be triggered by. These are the EXISTING
 * EventEmitter2 events already emitted across the platform — the workflow
 * listener subscribes to them, so no new emit points are invented. Adding a
 * trigger later is just adding the event here + one `@OnEvent` in the listener.
 */
export const WORKFLOW_TRIGGER = {
  APPOINTMENT_CREATED: APPOINTMENT_EVENT.CREATED,
  APPOINTMENT_UPDATED: APPOINTMENT_EVENT.UPDATED,
  APPOINTMENT_CONFIRMED: APPOINTMENT_EVENT.CONFIRMED,
  APPOINTMENT_CANCELLED: APPOINTMENT_EVENT.CANCELLED,
  APPOINTMENT_COMPLETED: APPOINTMENT_EVENT.COMPLETED,
  APPOINTMENT_RESCHEDULED: APPOINTMENT_EVENT.RESCHEDULED,
  APPOINTMENT_NO_SHOW: APPOINTMENT_EVENT.NO_SHOW,
  CUSTOMER_BIRTHDAY: CUSTOMER_EVENT.BIRTHDAY,
  PAYMENT_SUCCEEDED: PAYMENT_EVENT.SUCCEEDED,
  PAYMENT_REFUNDED: PAYMENT_EVENT.REFUNDED,
  PAYMENT_FAILED: PAYMENT_EVENT.FAILED,
  SUBSCRIPTION_ACTIVATED: SUBSCRIPTION_EVENT.ACTIVATED,
  SUBSCRIPTION_TRIAL_STARTED: SUBSCRIPTION_EVENT.TRIAL_STARTED,
  SUBSCRIPTION_CANCELLED: SUBSCRIPTION_EVENT.CANCELLED,
  SUBSCRIPTION_PLAN_CHANGED: SUBSCRIPTION_EVENT.PLAN_CHANGED,
  SUBSCRIPTION_REACTIVATED: SUBSCRIPTION_EVENT.REACTIVATED,
} as const;

export type WorkflowTrigger =
  (typeof WORKFLOW_TRIGGER)[keyof typeof WORKFLOW_TRIGGER];

/** All valid trigger event strings (for DTO validation). */
export const WORKFLOW_TRIGGERS: string[] = Object.values(WORKFLOW_TRIGGER);

/**
 * The clinic-local hour (0-23) at which the birthday sweep greets patients —
 * mid-morning, so a greeting never lands in the middle of the night. The sweep
 * itself ticks hourly and acts for a tenant only during this local hour.
 */
export const BIRTHDAY_SEND_LOCAL_HOUR = 9;

/**
 * Placeholders a plain-text WHATSAPP action's `text` may contain, resolved at
 * send time from the recipient patient and the clinic. Same `{{name}}` syntax
 * `renderTemplateBody` already uses for approved WhatsApp templates.
 */
export const WORKFLOW_MESSAGE_PLACEHOLDER = {
  CUSTOMER_NAME: 'customerName',
  CLINIC_NAME: 'clinicName',
} as const;

/**
 * Action types — restricted to the two real patient/staff messaging
 * channels. `NOTIFICATION` (a free-text templateId into the generic
 * notification-rules pipeline), `WEBHOOK`, and `AI` were removed: every
 * workflow action now maps to exactly one of these two EXISTING services.
 */
export const WORKFLOW_ACTION_TYPE = {
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
} as const;

export type WorkflowActionType =
  (typeof WORKFLOW_ACTION_TYPE)[keyof typeof WORKFLOW_ACTION_TYPE];

export const WORKFLOW_ACTION_TYPES: string[] =
  Object.values(WORKFLOW_ACTION_TYPE);

/**
 * Who an EMAIL/WHATSAPP action sends to. Deliberately NOT the shared
 * `RECIPIENT_TYPE` from the notifications module (which also has USER/TENANT,
 * still legitimately produced by the notification-rules pipeline) — the
 * workflow builder only ever resolves a real phone/email for a customer or a
 * staff member, so its own contract is restricted to just those two.
 */
export const WORKFLOW_RECIPIENT_TYPE = {
  CUSTOMER: 'CUSTOMER',
  STAFF: 'STAFF',
} as const;

export type WorkflowRecipientType =
  (typeof WORKFLOW_RECIPIENT_TYPE)[keyof typeof WORKFLOW_RECIPIENT_TYPE];

export const WORKFLOW_RECIPIENT_TYPES: string[] = Object.values(
  WORKFLOW_RECIPIENT_TYPE,
);

/**
 * Curated, clinic-relevant subset of `EmailTemplateKey`
 * (`../email/email.templates.ts`) offered in the EMAIL action's template
 * dropdown — excludes auth/security/system-only keys (password reset, staff
 * credentials, security alerts, subscription/payment system mail) that have
 * no place in a clinic-authored patient/staff automation.
 */
export const WORKFLOW_EMAIL_TEMPLATE_KEYS: string[] = [
  'generic',
  'patient_notification',
  'doctor_notification',
  'appointment_confirmation',
  'appointment_reminder',
  'appointment_cancelled',
  'appointment_rescheduled',
  'campaign_marketing',
];

/** Condition operators evaluated against the run context (AND across all). */
export const WORKFLOW_OPERATOR = {
  EQ: 'eq',
  NEQ: 'neq',
  GT: 'gt',
  GTE: 'gte',
  LT: 'lt',
  LTE: 'lte',
  IN: 'in',
  CONTAINS: 'contains',
  EXISTS: 'exists',
} as const;

export type WorkflowOperator =
  (typeof WORKFLOW_OPERATOR)[keyof typeof WORKFLOW_OPERATOR];

export const WORKFLOW_OPERATORS: string[] = Object.values(WORKFLOW_OPERATOR);

export const WORKFLOW_RUN_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;

/**
 * How long an IN_PROGRESS action claim (see `WorkflowService.claimAction`) is
 * honored before it is treated as abandoned and reclaimable. Must exceed the
 * slowest legitimate single-action execution (webhook capped at
 * `WORKFLOW_WEBHOOK_TIMEOUT_MS`, ~8s by default; email/WhatsApp/AI calls are
 * typically sub-second to a few seconds) with generous margin, so a real
 * still-running action is never reclaimed out from under itself — only a
 * claim whose owning process crashed without ever writing a terminal result.
 */
export const WORKFLOW_ACTION_CLAIM_STALE_MS = 10 * 60_000;

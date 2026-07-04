import { APPOINTMENT_EVENT } from '../../events/appointment.events';
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
  PAYMENT_SUCCEEDED: PAYMENT_EVENT.SUCCEEDED,
  PAYMENT_REFUNDED: PAYMENT_EVENT.REFUNDED,
  PAYMENT_FAILED: PAYMENT_EVENT.FAILED,
  SUBSCRIPTION_ACTIVATED: SUBSCRIPTION_EVENT.ACTIVATED,
  SUBSCRIPTION_TRIAL_STARTED: SUBSCRIPTION_EVENT.TRIAL_STARTED,
  SUBSCRIPTION_CANCELLED: SUBSCRIPTION_EVENT.CANCELLED,
  SUBSCRIPTION_PLAN_CHANGED: SUBSCRIPTION_EVENT.PLAN_CHANGED,
  SUBSCRIPTION_REACTIVATED: SUBSCRIPTION_EVENT.REACTIVATED,
} as const;

export type WorkflowTrigger = (typeof WORKFLOW_TRIGGER)[keyof typeof WORKFLOW_TRIGGER];

/** All valid trigger event strings (for DTO validation). */
export const WORKFLOW_TRIGGERS: string[] = Object.values(WORKFLOW_TRIGGER);

/** Action types — each maps to an EXISTING service in the executor. */
export const WORKFLOW_ACTION_TYPE = {
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
  NOTIFICATION: 'NOTIFICATION',
  WEBHOOK: 'WEBHOOK',
  AI: 'AI',
} as const;

export type WorkflowActionType =
  (typeof WORKFLOW_ACTION_TYPE)[keyof typeof WORKFLOW_ACTION_TYPE];

export const WORKFLOW_ACTION_TYPES: string[] = Object.values(WORKFLOW_ACTION_TYPE);

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

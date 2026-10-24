import { APPOINTMENT_EVENT } from '../../../events/appointment.events';

/**
 * The ready-made automation rules, defined in code (like the WhatsApp template
 * library): one definition for every clinic, reviewed in git. A clinic's own copy
 * is a `notification_rules` row with `rule_key` set, created DISABLED.
 *
 * Nothing here is executed: a rule is data (a trigger, a delay, typed settings)
 * interpreted by the existing, hardened pipeline.
 */

export const RULE_KEY = {
  BOOKING_CONFIRMATION: 'booking_confirmation',
  REMINDER_24H: 'reminder_24h',
  POST_VISIT_FOLLOWUP: 'post_visit_followup',
  FOLLOWUP_DUE: 'followup_due',
  SCHEDULED_PROMOTION: 'scheduled_promotion',
  PATIENT_REENGAGEMENT: 'patient_reengagement',
} as const;

export type RuleKey = (typeof RULE_KEY)[keyof typeof RULE_KEY];

/** Triggers that no domain event produces: a periodic sweep raises them instead. */
export const SWEEP_TRIGGER = {
  FOLLOWUP_DUE: 'appointment.followup_due',
  PATIENT_REENGAGEMENT: 'customer.reengagement',
  CAMPAIGN_SCHEDULED: 'campaign.scheduled',
} as const;

export type ConditionKey =
  | 'sendWindow'
  | 'inactivityDays'
  | 'cooldownDays'
  | 'dailyCap';

export interface RuleLibraryDef {
  key: RuleKey;
  /** Display name (English fallback; the UI localises by `key`). */
  name: string;
  trigger: string;
  anchor: 'AFTER_EVENT' | 'BEFORE_APPOINTMENT_START';
  defaultDelayMinutes: number;
  /** Inclusive bounds the delay may be set within. */
  delayRange: [number, number];
  /** `WhatsappTemplateLibrary` key of the template this rule is meant for. */
  templateLibraryKey?: string;
  /** False for the scheduled-promotion rule: it launches CAMPAIGNS, which carry their own template. */
  usesTemplate: boolean;
  /** The rule needs a message category consent check (it sends marketing content). */
  marketing: boolean;
  /** False until the feature behind the trigger exists; such a rule cannot be enabled. */
  available: boolean;
  conditions: ConditionKey[];
  defaultConditions: Record<string, unknown>;
}

const SEND_WINDOW = { startHour: 9, endHour: 21 };

export const RULE_LIBRARY: RuleLibraryDef[] = [
  {
    key: RULE_KEY.BOOKING_CONFIRMATION,
    name: 'Booking confirmation',
    trigger: APPOINTMENT_EVENT.CONFIRMED,
    anchor: 'AFTER_EVENT',
    defaultDelayMinutes: 0,
    delayRange: [0, 60],
    templateLibraryKey: 'appointment_confirmation',
    usesTemplate: true,
    marketing: false,
    available: true,
    // A confirmation is sent when the booking is made, at any hour.
    conditions: [],
    defaultConditions: {},
  },
  {
    key: RULE_KEY.REMINDER_24H,
    name: '24-hour reminder',
    trigger: APPOINTMENT_EVENT.CONFIRMED,
    anchor: 'BEFORE_APPOINTMENT_START',
    defaultDelayMinutes: 1440,
    delayRange: [60, 10_080],
    templateLibraryKey: 'appointment_reminder_24h',
    usesTemplate: true,
    marketing: false,
    available: true,
    conditions: ['sendWindow'],
    defaultConditions: { sendWindow: SEND_WINDOW },
  },
  {
    key: RULE_KEY.POST_VISIT_FOLLOWUP,
    name: 'Post-visit follow-up',
    trigger: APPOINTMENT_EVENT.COMPLETED,
    anchor: 'AFTER_EVENT',
    defaultDelayMinutes: 120,
    delayRange: [30, 4320],
    templateLibraryKey: 'post_visit_followup',
    usesTemplate: true,
    marketing: true,
    available: true,
    conditions: ['sendWindow'],
    defaultConditions: { sendWindow: SEND_WINDOW },
  },
  {
    key: RULE_KEY.FOLLOWUP_DUE,
    name: 'Medical follow-up when due',
    trigger: SWEEP_TRIGGER.FOLLOWUP_DUE,
    anchor: 'AFTER_EVENT',
    defaultDelayMinutes: 0,
    delayRange: [0, 0],
    templateLibraryKey: 'followup_booking_invitation',
    usesTemplate: true,
    marketing: true,
    // Driven by the date a clinician sets on a completed appointment
    // (`PUT /appointments/:id/follow-up`), noticed by the daily rules sweep.
    available: true,
    conditions: ['sendWindow'],
    defaultConditions: { sendWindow: SEND_WINDOW },
  },
  {
    key: RULE_KEY.SCHEDULED_PROMOTION,
    name: 'Scheduled promotional campaign',
    trigger: SWEEP_TRIGGER.CAMPAIGN_SCHEDULED,
    anchor: 'AFTER_EVENT',
    defaultDelayMinutes: 0,
    delayRange: [0, 0],
    templateLibraryKey: 'clinic_special_offer',
    usesTemplate: false,
    marketing: true,
    available: true,
    conditions: [],
    defaultConditions: {},
  },
  {
    key: RULE_KEY.PATIENT_REENGAGEMENT,
    name: 'Patient re-engagement',
    trigger: SWEEP_TRIGGER.PATIENT_REENGAGEMENT,
    anchor: 'AFTER_EVENT',
    defaultDelayMinutes: 0,
    delayRange: [0, 0],
    templateLibraryKey: 'patient_reengagement',
    usesTemplate: true,
    marketing: true,
    available: true,
    conditions: ['sendWindow', 'inactivityDays', 'cooldownDays', 'dailyCap'],
    defaultConditions: {
      sendWindow: SEND_WINDOW,
      inactivityDays: 180,
      cooldownDays: 90,
      dailyCap: 100,
    },
  },
];

export function findRuleDef(
  key: string | null | undefined,
): RuleLibraryDef | undefined {
  return RULE_LIBRARY.find((d) => d.key === key);
}

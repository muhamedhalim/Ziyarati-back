import { AiToolDefinition } from '../providers/ai-provider.interface';
import { PERMISSION, PermissionSlug } from '../../../rbac/rbac.constants';

/** Canonical tool names — shared by the schemas and the dispatcher switch. */
export const AI_TOOL = {
  // Public discovery (cross-tenant, read-only — safe for anonymous/guest chats).
  SEARCH_CLINICS: 'search_clinics',
  GET_CLINIC_DETAILS: 'get_clinic_details',
  SEARCH_PUBLIC_AVAILABILITY: 'search_public_availability',
  // Booking (tenant-bound, transactional — authenticated conversations only).
  CHECK_AVAILABILITY: 'check_availability',
  GET_CUSTOMER_INSURANCE_STATUS: 'get_customer_insurance_status',
  BOOK_APPOINTMENT: 'book_appointment',
  RESCHEDULE_APPOINTMENT: 'reschedule_appointment',
  CANCEL_APPOINTMENT: 'cancel_appointment',
  // Live Agent Handover — channel-agnostic escalation (works over WhatsApp,
  // which has no socket connection to emit `ai:handover` directly).
  REQUEST_HUMAN_HANDOVER: 'request_human_handover',
} as const;

export type AiToolName = (typeof AI_TOOL)[keyof typeof AI_TOOL];

/**
 * Permission each transactional tool requires, mirroring the exact check
 * `AiToolDispatchService` already enforces at execution time.
 *
 * Used by `AiExecutionService.availableTools` to stop advertising a tool the
 * acting principal could never run (F-7). Tools absent from this map are
 * read-only discovery or channel-agnostic escalation and need no permission.
 * The dispatcher stays the enforcement point — this is defense in depth, so
 * the two must not drift.
 */
export const AI_TOOL_PERMISSION: Partial<Record<string, PermissionSlug>> = {
  [AI_TOOL.BOOK_APPOINTMENT]: PERMISSION.APPOINTMENTS_CREATE,
  [AI_TOOL.RESCHEDULE_APPOINTMENT]: PERMISSION.APPOINTMENTS_RESCHEDULE,
  [AI_TOOL.CANCEL_APPOINTMENT]: PERMISSION.APPOINTMENTS_CANCEL,
};

/**
 * The booking toolset exposed to the model.
 *
 * These are INTENT declarations only — the model proposes a call with arguments;
 * the AiToolDispatchService validates and executes it through the existing
 * AvailabilityService / AppointmentsService (the model never touches the DB).
 * Note there is intentionally no `tenantId` parameter: the tenant is bound from
 * the execution context, never supplied by the model.
 */
export const AI_TOOLS: AiToolDefinition[] = [
  {
    name: AI_TOOL.SEARCH_CLINICS,
    description:
      'Search public clinics by name or by an offered service (e.g. "dentist", "tooth pain", "physiotherapy"). Call this when the visitor describes a need or asks to find a clinic. Returns clinic cards (id, name, branch count, sample services) to present to the user.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text need or clinic/service name. Omit to list clinics.',
        },
        limit: {
          type: 'integer',
          description: 'Max clinics to return (default 12, max 24).',
        },
      },
      required: [],
    },
  },
  {
    name: AI_TOOL.GET_CLINIC_DETAILS,
    description:
      "Get a chosen clinic's branches, doctors and services (with prices). Call this after the user selects a clinic from search_clinics, so you can offer branches, doctors and services to pick from.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clinicId: {
          type: 'string',
          description: 'Clinic (tenant) UUID from search_clinics.',
        },
      },
      required: ['clinicId'],
    },
  },
  {
    name: AI_TOOL.SEARCH_PUBLIC_AVAILABILITY,
    description:
      'List the free appointment time windows for a doctor at a branch on a given day, for a clinic discovered publicly. Call this after the user picks a branch and doctor, to offer bookable slots. The owning clinic is resolved server-side from the branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description: 'Branch UUID from get_clinic_details.',
        },
        staffId: {
          type: 'string',
          description: 'Doctor UUID from get_clinic_details.',
        },
        date: { type: 'string', description: 'Target day in YYYY-MM-DD.' },
        slotMinutes: {
          type: 'integer',
          description:
            'Optional: chunk free time into fixed slots of N minutes.',
        },
      },
      required: ['branchId', 'staffId', 'date'],
    },
  },
  {
    name: AI_TOOL.CHECK_AVAILABILITY,
    description:
      'List the free appointment time windows for a staff member at a branch on a given day. Call this before booking to find a slot the customer can choose.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: { type: 'string', description: 'Branch UUID.' },
        staffId: { type: 'string', description: 'Staff member UUID.' },
        date: { type: 'string', description: 'Target day in YYYY-MM-DD.' },
        slotMinutes: {
          type: 'integer',
          description:
            'Optional: chunk free time into fixed slots of N minutes.',
        },
      },
      required: ['branchId', 'staffId', 'date'],
    },
  },
  {
    name: AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
    description:
      'Check whether this patient\'s health-insurance status is already on file, before asking. Call this once, early in a booking flow, right after the customer is identified. Returns hasInsurance: true, false, or null (never asked before). If a value comes back (true or false), briefly CONFIRM it with the patient (e.g. "I have you down as having health insurance — is that still correct?") instead of asking cold. If null, ask the question fresh (see book_appointment for the exact wording).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: {
          type: 'string',
          description:
            'Customer UUID. Omit to use the customer already bound to this conversation.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_TOOL.BOOK_APPOINTMENT,
    description:
      'Book a new appointment for a customer. Only call after confirming an available slot via check_availability. ' +
      "Before booking, you must know the patient's health-insurance status: call get_customer_insurance_status first. " +
      'If it returns a known value, confirm it with the patient rather than asking again. If it returns null (unknown), ask exactly — ' +
      'Arabic: "هل لديك تأمين صحي؟" / English: "Do you have health insurance?" — with Yes/No options, then pass the confirmed answer as hasInsurance. ' +
      'Insured patients are never charged online: no payment link is generated for them, regardless of what you say. ' +
      "Uninsured patients may get a payment link in this tool's result when the clinic requires online payment for this booking — if `paymentLink` is present in the result, share its details with the patient so they can complete payment; the decision to include it is made by the backend, not by you. " +
      'The booking itself is validated for real availability and fails if the slot is taken.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: { type: 'string', description: 'Branch UUID.' },
        customerId: {
          type: 'string',
          description: 'Customer UUID (the person being booked).',
        },
        staffId: { type: 'string', description: 'Staff member UUID.' },
        startAt: {
          type: 'string',
          description: 'Start time, ISO-8601 with timezone offset.',
        },
        serviceIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional service UUIDs; their durations set the end time and prices the total.',
        },
        notes: { type: 'string', description: 'Optional booking notes.' },
        hasInsurance: {
          type: 'boolean',
          description:
            'The patient\'s confirmed health-insurance answer for this turn (from get_customer_insurance_status confirmation, or a fresh answer). Omit only if you truly could not obtain one — the backend then falls back to the on-file value, defaulting to "no insurance" if it was never asked.',
        },
      },
      required: ['branchId', 'customerId', 'staffId', 'startAt'],
    },
  },
  {
    name: AI_TOOL.RESCHEDULE_APPOINTMENT,
    description:
      'Move an existing appointment to a new start time. The new window is availability-checked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string', description: 'Appointment UUID.' },
        newStartAt: {
          type: 'string',
          description: 'New start time, ISO-8601 with offset.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason (stored in the audit trail).',
        },
        // AI-019/PD-1/F1: irreversible — the FIRST call (no token, or an
        // invalid/expired one) is refused and returns a fresh
        // application-issued confirmationToken instead of executing; the
        // model relays it back to confirm. The application independently
        // verifies this token server-side — it is never trusted merely
        // because the model supplied it (FR-073).
        confirmationToken: {
          type: 'string',
          description:
            'Application-issued confirmation token from a prior refused call to this same tool for this same appointment. Omit on the first attempt.',
        },
      },
      required: ['appointmentId', 'newStartAt'],
    },
  },
  {
    name: AI_TOOL.CANCEL_APPOINTMENT,
    description: 'Cancel an existing appointment.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string', description: 'Appointment UUID.' },
        reason: {
          type: 'string',
          description:
            'Optional cancellation reason (stored in the audit trail).',
        },
        // AI-019/PD-1/F1 — see reschedule_appointment's identical property.
        confirmationToken: {
          type: 'string',
          description:
            'Application-issued confirmation token from a prior refused call to this same tool for this same appointment. Omit on the first attempt.',
        },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: AI_TOOL.REQUEST_HUMAN_HANDOVER,
    description:
      'Escalate this conversation to a human agent. Call this whenever the visitor explicitly asks to speak to a person/human/agent/support, or when you cannot help with their request. Works over every channel (website, WhatsApp, dashboard) — you will stop responding after this call; a human will take over.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description:
            "Brief reason for the escalation, for the agent's context.",
        },
      },
      required: [],
    },
  },
];

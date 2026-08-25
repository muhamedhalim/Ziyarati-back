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
  // Own-clinic discovery (tenant-bound, read-only — the WhatsApp channel's
  // equivalent of the guest's search_clinics/get_clinic_details: an
  // AUTHENTICATED turn (the WhatsApp bot actor) has no public booking
  // session to resolve a branch from, and no `clinicId` to pass
  // get_clinic_details, because it already represents exactly one clinic —
  // its own tenant. Named `list_clinic_*`, not `list_branch_*`, because
  // `list_branch_doctors`/`list_branch_services` already exist as
  // AI_PUBLIC_TOOL values bound to the public booking session; reusing
  // those names would collide in the dispatcher switch.
  LIST_CLINIC_BRANCHES: 'list_clinic_branches',
  LIST_CLINIC_DOCTORS: 'list_clinic_doctors',
  LIST_CLINIC_SERVICES: 'list_clinic_services',
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
      'Search the DATABASE of publicly bookable clinics by name or by an offered service (e.g. "dentist", "tooth pain", "physiotherapy"). Call this when the visitor describes a need or asks to find a clinic. Returns clinic cards (id, name, branch count, sample services) to present to the user. ' +
      'This tool — not the <knowledge> block — is what decides whether a clinic can be booked: a clinic returned here IS bookable, and a clinic described in <knowledge> but absent here is NOT. ' +
      'To narrow to a city pass `cityId`; NEVER put a city name in `query`, which matches clinic and service names only and will find nothing. ' +
      'Call it with NO arguments at all to list every bookable clinic — that is the right call for "whatever you have available" and whenever `list_cities` came back empty.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text need or clinic/service name. Omit to list clinics. Never a city name.',
        },
        cityId: {
          type: 'string',
          description:
            'Optional city UUID from list_cities. Narrows to clinics with an active branch in that city. Once supplied and accepted it is remembered for the rest of the conversation.',
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
    name: AI_TOOL.LIST_CLINIC_BRANCHES,
    description:
      "List THIS clinic's own active branches (id, name, address). This is the FIRST call in any WhatsApp booking flow — there is no other way to learn a valid branchId. Never invent or guess a branchId; only use one returned here.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: AI_TOOL.LIST_CLINIC_DOCTORS,
    description:
      "List the doctors who work at one of THIS clinic's branches, chosen from list_clinic_branches. Call this (and/or list_clinic_services) after the branch is chosen, before check_availability.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description: 'Branch UUID from list_clinic_branches.',
        },
      },
      required: ['branchId'],
    },
  },
  {
    name: AI_TOOL.LIST_CLINIC_SERVICES,
    description:
      "List the services (with prices) offered at one of THIS clinic's branches, chosen from list_clinic_branches. Call this (and/or list_clinic_doctors) after the branch is chosen, before book_appointment.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description: 'Branch UUID from list_clinic_branches.',
        },
      },
      required: ['branchId'],
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

/**
 * The toolset offered to an inbound WhatsApp turn: own-clinic discovery
 * (never cross-tenant search) + the tenant-bound booking tools + handover.
 *
 * Deliberately EXCLUDES `search_clinics` / `get_clinic_details` /
 * `search_public_availability` — those are cross-tenant discovery, safe only
 * for an anonymous guest turn that has not yet picked a clinic. A patient
 * messaging Clinic A's own WhatsApp number must never be shown Clinic B: the
 * clinic is already fixed by which `phone_number_id` the message arrived on,
 * so offering the model a way to search OTHER clinics is pure disclosure
 * surface with no legitimate use on this channel.
 *
 * Consumed by `AiExecutionService.availableTools()` — see its WHATSAPP
 * branch. Kept next to `AI_TOOLS` (not inline in the execution service) so
 * the tool catalogue and its channel matrix stay in one file.
 */
export const WHATSAPP_CHANNEL_TOOL_NAMES: string[] = [
  AI_TOOL.LIST_CLINIC_BRANCHES,
  AI_TOOL.LIST_CLINIC_DOCTORS,
  AI_TOOL.LIST_CLINIC_SERVICES,
  AI_TOOL.CHECK_AVAILABILITY,
  AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
  AI_TOOL.BOOK_APPOINTMENT,
  AI_TOOL.RESCHEDULE_APPOINTMENT,
  AI_TOOL.CANCEL_APPOINTMENT,
  AI_TOOL.REQUEST_HUMAN_HANDOVER,
];

/**
 * Tools that exist ONLY for the WhatsApp own-clinic discovery step — never
 * meant for the staff/dashboard branch of `availableTools()`, which already
 * has its own operational surfaces for branches, doctors and services.
 *
 * Named separately from `WHATSAPP_CHANNEL_TOOL_NAMES` (which also lists
 * `check_availability` / `book_appointment` / etc. — tools shared with, and
 * pre-existing on, the staff toolset) because the staff branch's filter
 * default-INCLUDES any `AI_TOOLS` entry absent from `AI_TOOL_PERMISSION`
 * (see `AiExecutionService.availableTools()`) — without this explicit
 * exclusion, adding these three to the shared `AI_TOOLS` array would have
 * silently leaked them into the dashboard toolset too.
 */
export const WHATSAPP_ONLY_TOOL_NAMES: string[] = [
  AI_TOOL.LIST_CLINIC_BRANCHES,
  AI_TOOL.LIST_CLINIC_DOCTORS,
  AI_TOOL.LIST_CLINIC_SERVICES,
];

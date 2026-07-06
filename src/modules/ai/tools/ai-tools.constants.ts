import { AiToolDefinition } from '../providers/ai-provider.interface';

/** Canonical tool names — shared by the schemas and the dispatcher switch. */
export const AI_TOOL = {
  // Public discovery (cross-tenant, read-only — safe for anonymous/guest chats).
  SEARCH_CLINICS: 'search_clinics',
  GET_CLINIC_DETAILS: 'get_clinic_details',
  SEARCH_PUBLIC_AVAILABILITY: 'search_public_availability',
  // Booking (tenant-bound, transactional — authenticated conversations only).
  CHECK_AVAILABILITY: 'check_availability',
  BOOK_APPOINTMENT: 'book_appointment',
  RESCHEDULE_APPOINTMENT: 'reschedule_appointment',
  CANCEL_APPOINTMENT: 'cancel_appointment',
  // Live Agent Handover — channel-agnostic escalation (works over WhatsApp,
  // which has no socket connection to emit `ai:handover` directly).
  REQUEST_HUMAN_HANDOVER: 'request_human_handover',
} as const;

export type AiToolName = (typeof AI_TOOL)[keyof typeof AI_TOOL];

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
          description: 'Free-text need or clinic/service name. Omit to list clinics.',
        },
        limit: { type: 'integer', description: 'Max clinics to return (default 12, max 24).' },
      },
      required: [],
    },
  },
  {
    name: AI_TOOL.GET_CLINIC_DETAILS,
    description:
      'Get a chosen clinic\'s branches, doctors and services (with prices). Call this after the user selects a clinic from search_clinics, so you can offer branches, doctors and services to pick from.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clinicId: { type: 'string', description: 'Clinic (tenant) UUID from search_clinics.' },
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
        branchId: { type: 'string', description: 'Branch UUID from get_clinic_details.' },
        staffId: { type: 'string', description: 'Doctor UUID from get_clinic_details.' },
        date: { type: 'string', description: 'Target day in YYYY-MM-DD.' },
        slotMinutes: {
          type: 'integer',
          description: 'Optional: chunk free time into fixed slots of N minutes.',
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
          description: 'Optional: chunk free time into fixed slots of N minutes.',
        },
      },
      required: ['branchId', 'staffId', 'date'],
    },
  },
  {
    name: AI_TOOL.BOOK_APPOINTMENT,
    description:
      'Book a new appointment for a customer. Only call after confirming an available slot via check_availability. The booking is validated for real availability and fails if the slot is taken.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: { type: 'string', description: 'Branch UUID.' },
        customerId: { type: 'string', description: 'Customer UUID (the person being booked).' },
        staffId: { type: 'string', description: 'Staff member UUID.' },
        startAt: { type: 'string', description: 'Start time, ISO-8601 with timezone offset.' },
        serviceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional service UUIDs; their durations set the end time and prices the total.',
        },
        notes: { type: 'string', description: 'Optional booking notes.' },
      },
      required: ['branchId', 'customerId', 'staffId', 'startAt'],
    },
  },
  {
    name: AI_TOOL.RESCHEDULE_APPOINTMENT,
    description: 'Move an existing appointment to a new start time. The new window is availability-checked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string', description: 'Appointment UUID.' },
        newStartAt: { type: 'string', description: 'New start time, ISO-8601 with offset.' },
        reason: { type: 'string', description: 'Optional reason (stored in the audit trail).' },
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
        reason: { type: 'string', description: 'Optional cancellation reason (stored in the audit trail).' },
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
        reason: { type: 'string', description: 'Brief reason for the escalation, for the agent\'s context.' },
      },
      required: [],
    },
  },
];

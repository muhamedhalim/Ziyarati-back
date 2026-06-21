import { AiToolDefinition } from '../providers/ai-provider.interface';

/** Canonical tool names — shared by the schemas and the dispatcher switch. */
export const AI_TOOL = {
  CHECK_AVAILABILITY: 'check_availability',
  BOOK_APPOINTMENT: 'book_appointment',
  RESCHEDULE_APPOINTMENT: 'reschedule_appointment',
  CANCEL_APPOINTMENT: 'cancel_appointment',
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
];

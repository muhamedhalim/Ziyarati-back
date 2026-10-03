import { AiToolDefinition } from '../providers/ai-provider.interface';
import { PERMISSION, PermissionSlug } from '../../../rbac/rbac.constants';

/** Canonical tool names — shared by the schemas and the dispatcher switch. */
export const AI_TOOL = {
  // Public discovery (cross-tenant, read-only — safe for anonymous/guest chats).
  SEARCH_CLINICS: 'search_clinics',
  GET_CLINIC_DETAILS: 'get_clinic_details',
  SEARCH_PUBLIC_AVAILABILITY: 'search_public_availability',
  // Branch facts (WHERE it is, WHEN it is open) and a doctor's recurring
  // roster (WHICH days they work). Neither question is an availability
  // question, and answering them by running an availability check — which is
  // all the assistant could previously do — turns "what are your hours?" into
  // "the doctor is unavailable". Both are read-only and tenant-safe: the
  // public path resolves ids from the server-side booking session, the
  // authenticated path from `ctx.tenantId`.
  GET_BRANCH_INFO: 'get_branch_info',
  GET_DOCTOR_SCHEDULE: 'get_doctor_schedule',
  // Booking (tenant-bound, transactional — authenticated conversations only).
  CHECK_AVAILABILITY: 'check_availability',
  GET_CUSTOMER_INSURANCE_STATUS: 'get_customer_insurance_status',
  BOOK_APPOINTMENT: 'book_appointment',
  RESCHEDULE_APPOINTMENT: 'reschedule_appointment',
  CANCEL_APPOINTMENT: 'cancel_appointment',
  // The patient's OWN upcoming appointments, bound to the server-side customer of
  // the conversation. It is the only place an appointmentId for cancel/reschedule
  // can come from — the patient is never asked to type one.
  LIST_MY_APPOINTMENTS: 'list_my_appointments',
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
  [AI_TOOL.LIST_MY_APPOINTMENTS]: PERMISSION.APPOINTMENTS_READ,
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
    name: AI_TOOL.GET_BRANCH_INFO,
    description:
      'WHERE a branch is and WHEN it is open — its address, city, phone, timezone, and its published weekly working hours. This is the ONLY tool that answers "what are your working hours?", "when do you open?", "where are you?", "what is your address/phone?". NEVER answer any of those by checking a doctor\'s availability, and never invent hours or a location. ' +
      'Each day comes back as OPEN (with hours), CLOSED (the clinic marked it closed) or NOT_PUBLISHED (the clinic never entered hours for that day) — report those three differently: NOT_PUBLISHED means "the clinic has not published hours for that day", NOT "we are closed". ' +
      'A null address or phone means the clinic has not published it: say so and offer what you do have, never guess.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description:
            'Branch UUID. On the public website widget, OMIT this — the branch already selected in this conversation is used automatically.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_TOOL.GET_DOCTOR_SCHEDULE,
    description:
      'Which DAYS OF THE WEEK and hours a doctor is rostered at a branch — the answer to "when does Dr. X work?", "what are the doctor\'s days?", "when is Dr. X at the clinic?". ' +
      'This is the recurring roster, NOT free time: it does not subtract existing bookings, holidays or leave. To offer real bookable times, follow it with the availability tool. ' +
      "Use this when the visitor asks about the doctor's WORKING PATTERN, and the availability tool when they ask about BOOKABLE TIMES or a specific date.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        staffId: {
          type: 'string',
          description:
            'Doctor UUID. On the public website widget, OMIT this — the doctor already selected in this conversation is used automatically.',
        },
        branchId: {
          type: 'string',
          description:
            'Branch UUID. On the public website widget, OMIT this — the selected branch is used automatically.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_TOOL.SEARCH_PUBLIC_AVAILABILITY,
    description:
      'REAL bookable appointment times for a doctor at a branch, for a clinic discovered publicly. Returns one entry PER DAY, each with concrete slots and, when a day has none, a `reason` saying why (not_working_that_day, fully_booked, holiday, time_off, no_gap_long_enough). ' +
      'Slot length is set SERVER-SIDE from the selected service, so every time returned is genuinely bookable end-to-end — do not pass slotMinutes yourself. ' +
      'If the day you asked about has nothing, this tool KEEPS LOOKING and returns the next days that do, under `nextAvailable`. So never reply "the doctor is unavailable" and stop: state the reason for the day they asked about, then offer what came back in `nextAvailable`. ' +
      'Omit `date` to answer an open-ended "when is the doctor free?". Give a `date` for a specific day. The owning clinic is resolved server-side from the branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description:
            'Branch UUID. On the public website widget, OMIT this — the selected branch is used automatically.',
        },
        staffId: {
          type: 'string',
          description:
            'Doctor UUID. On the public website widget, OMIT this — the selected doctor is used automatically.',
        },
        date: {
          type: 'string',
          description:
            'A specific day in YYYY-MM-DD, resolved from the date given in the context block — never from memory. Omit for "when is the doctor next free?".',
        },
        daysAhead: {
          type: 'integer',
          description:
            'How many days from `date` to search (default 7, max 14). Raise it only when a first search came back empty.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_TOOL.CHECK_AVAILABILITY,
    description:
      'REAL bookable appointment times for a staff member at a branch. Returns one entry PER DAY, each with concrete slots and, when a day has none, a `reason` (not_working_that_day, fully_booked, holiday, time_off, no_gap_long_enough). ' +
      'When the requested day has nothing, the tool searches forward and returns the next days that do under `nextAvailable` — offer those instead of reporting a dead end. Omit `date` for "when is this person next free?". Call before booking to find a slot the customer can choose.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: { type: 'string', description: 'Branch UUID.' },
        staffId: { type: 'string', description: 'Staff member UUID.' },
        date: {
          type: 'string',
          description:
            'A specific day in YYYY-MM-DD. Omit to search from today onward.',
        },
        daysAhead: {
          type: 'integer',
          description:
            'How many days from `date` to search (default 7, max 14).',
        },
        slotMinutes: {
          type: 'integer',
          description:
            'Optional: chunk free time into fixed slots of N minutes. Pass the service duration so every slot returned actually fits the appointment.',
        },
      },
      required: ['branchId', 'staffId'],
    },
  },
  {
    name: AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
    description:
      'Check whether this patient\'s health-insurance status is already on file, before asking. Call this once, early in a booking flow, right after the customer is identified. Returns hasInsurance: true, false, or null (never asked before). If a value comes back (true or false), briefly confirm it with the patient (e.g. "I have you down as having health insurance — is that still correct?") instead of asking cold. If null, ask the question fresh (see book_appointment for how to phrase it).',
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
      'If it returns a known value, confirm it with the patient rather than asking again. If it returns null (unknown), ask a plain yes/no question, IN THE LANGUAGE THE PATIENT HAS BEEN USING (never a fixed script and never switch language for this one question), then pass the answer as hasInsurance. ' +
      'Insured patients are never charged online: no payment link is generated for them, regardless of what you say. ' +
      "Uninsured patients may get a payment link in this tool's result when the clinic requires online payment for this booking — if `paymentLink` is present in the result, share its `payUrl` and amount with the patient so they can complete payment; the decision to include it is made by the backend, not by you. " +
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
            'The patient\'s health-insurance answer for this turn (from get_customer_insurance_status confirmation, or a fresh answer). Omit only if you truly could not obtain one — the backend then falls back to the on-file value, defaulting to "no insurance" if it was never asked.',
        },
      },
      required: ['branchId', 'customerId', 'staffId', 'startAt'],
    },
  },
  {
    name: AI_TOOL.RESCHEDULE_APPOINTMENT,
    description:
      'Move an existing appointment to a new start time. The new window is availability-checked. ' +
      'The first call only asks for confirmation (it changes nothing): put the exact change to the patient, wait for their reply, ' +
      'then call again with the SAME appointmentId and newStartAt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: {
          type: 'string',
          description:
            'Appointment UUID, exactly as returned by list_my_appointments.',
        },
        newStartAt: {
          type: 'string',
          description: 'New start time, ISO-8601 with offset.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason (stored in the audit trail).',
        },
        // AI-019/PD-1/F1: irreversible — the FIRST call is refused and the
        // application records what is being confirmed, server-side. The
        // change executes only when the SAME call arrives in a LATER user turn
        // (F-04): the application verifies that itself and never trusts the
        // model's claim that the patient agreed (FR-073). The token is what
        // the refused call returns; it is optional on the confirming call,
        // because a tool result does not survive into the next turn.
        confirmationToken: {
          type: 'string',
          description:
            'Optional. The token the confirmation request returned, if you still have it; the confirming call works without it.',
        },
      },
      required: ['appointmentId', 'newStartAt'],
    },
  },
  {
    name: AI_TOOL.CANCEL_APPOINTMENT,
    description:
      'Cancel an existing appointment. The first call only asks for confirmation (it changes nothing): ' +
      'put the exact appointment to the patient, wait for their reply, then call again with the SAME appointmentId.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: {
          type: 'string',
          description:
            'Appointment UUID, exactly as returned by list_my_appointments.',
        },
        reason: {
          type: 'string',
          description:
            'Optional cancellation reason (stored in the audit trail).',
        },
        // AI-019/PD-1/F1 — see reschedule_appointment's identical property.
        confirmationToken: {
          type: 'string',
          description:
            'Optional. The token the confirmation request returned, if you still have it; the confirming call works without it.',
        },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: AI_TOOL.LIST_MY_APPOINTMENTS,
    description:
      "List THIS patient's own upcoming appointments (id, date and time, doctor, branch, services). " +
      'Call it before cancel_appointment or reschedule_appointment: it is the only source of an appointmentId — never ask the patient for one, and never use an id from anywhere else.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
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
      "List THIS clinic's doctors, with their title, bio and specialties. OMIT branchId to answer a general 'who are your doctors?' / 'do you have a specialist for X?' across every branch — do NOT ask which branch first just to answer that. Pass branchId (from list_clinic_branches) only once you actually need branch-scoped doctors, e.g. right before check_availability.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description:
            'Branch UUID from list_clinic_branches. Omit for a clinic-wide list.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_TOOL.LIST_CLINIC_SERVICES,
    description:
      "List THIS clinic's services, with description, duration and price. OMIT branchId to answer a general 'what services do you offer?' / 'do you do X?' across every branch — do NOT ask which branch first just to answer that. Pass branchId (from list_clinic_branches) only once you actually need branch-scoped prices, e.g. right before book_appointment.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description:
            'Branch UUID from list_clinic_branches. Omit for a clinic-wide list.',
        },
      },
      required: [],
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
  // Own-clinic facts (address / hours / roster). Tenant-bound exactly like
  // every other tool on this channel — `ctx.tenantId`, never an argument — so
  // a patient on Clinic A's number can only ever read Clinic A.
  AI_TOOL.GET_BRANCH_INFO,
  AI_TOOL.GET_DOCTOR_SCHEDULE,
  AI_TOOL.CHECK_AVAILABILITY,
  AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
  AI_TOOL.BOOK_APPOINTMENT,
  AI_TOOL.RESCHEDULE_APPOINTMENT,
  AI_TOOL.CANCEL_APPOINTMENT,
  // The patient's own appointments, from the server-bound customer of this
  // conversation — where a cancel/reschedule id comes from.
  AI_TOOL.LIST_MY_APPOINTMENTS,
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
  // Needs a customer bound to the conversation, which only a WhatsApp contact has;
  // staff already list appointments through the dashboard tools.
  AI_TOOL.LIST_MY_APPOINTMENTS,
];

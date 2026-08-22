import { AiToolDefinition } from '../providers/ai-provider.interface';
import { AI_TOOL } from './ai-tools.constants';

/**
 * Tools for the PUBLIC (anonymous) booking assistant.
 *
 * Two properties make this set safe to hand to a visitor who holds no
 * permissions and no clinic tenant:
 *
 *  1. **No `tenantId` anywhere** — same rule the staff toolset already follows,
 *     but here it goes further: `book_public_appointment` takes no resource ids
 *     AT ALL. Branch, service, doctor and slot all come from the server-side
 *     session recorded by the `select_*` tools, so there is simply no id
 *     argument left for a prompt injection to poison.
 *  2. **`select_*` tools validate before they record.** The model proposes a
 *     choice; the backend checks it against live data (does this branch belong
 *     to that clinic? is this doctor scheduled at that branch?) and only then
 *     persists it. The session is authoritative; the conversation is not.
 *
 * The visitor never gains `appointments.create`. The booking executes under the
 * SELECTED clinic's own least-privilege `ai-bot` actor — the same pattern the
 * WhatsApp flow already uses.
 */
export const AI_PUBLIC_TOOL = {
  LIST_CITIES: 'list_cities',
  SELECT_CLINIC: 'select_clinic',
  SELECT_BRANCH: 'select_branch',
  LIST_BRANCH_SERVICES: 'list_branch_services',
  LIST_BRANCH_DOCTORS: 'list_branch_doctors',
  SELECT_SERVICE: 'select_service',
  SELECT_DOCTOR: 'select_doctor',
  SELECT_SLOT: 'select_slot',
  BOOK_PUBLIC_APPOINTMENT: 'book_public_appointment',
} as const;

export type AiPublicToolName =
  (typeof AI_PUBLIC_TOOL)[keyof typeof AI_PUBLIC_TOOL];

const PUBLIC_ONLY_TOOLS: AiToolDefinition[] = [
  {
    name: AI_PUBLIC_TOOL.LIST_CITIES,
    description:
      'List the cities that currently have bookable clinics. This is the FIRST STEP OF A BOOKING — call it only when the visitor wants to book an appointment and has not said which city they are in, then present the cities and ask which one they want. ' +
      'Do NOT call it to answer a question ABOUT a clinic (its address, working hours, services, prices, policies or FAQs): answer those from the <knowledge> block. ' +
      'An empty result means no clinic has opted in to public booking yet — it is not an answer to an informational question, so never report it as one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: AI_PUBLIC_TOOL.SELECT_CLINIC,
    description:
      'Record the clinic the visitor chose, from search_clinics or get_clinic_details. Call this as soon as they pick one — later steps read the recorded choice, not the chat history. If the clinic has exactly one active branch it is selected automatically and the result says so, in which case do NOT ask them to choose a branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clinicId: {
          type: 'string',
          description: 'Clinic UUID from search_clinics.',
        },
      },
      required: ['clinicId'],
    },
  },
  {
    name: AI_PUBLIC_TOOL.SELECT_BRANCH,
    description:
      'Record the branch the visitor chose. Only needed when the clinic has more than one branch (select_clinic tells you). The branch must belong to the selected clinic.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description: 'Branch UUID from get_clinic_details.',
        },
      },
      required: ['branchId'],
    },
  },
  {
    name: AI_PUBLIC_TOOL.LIST_BRANCH_SERVICES,
    description:
      "List the services actually offered AT the selected branch, with that branch's prices. Call this after the branch is selected — clinic-wide service lists may include services this branch does not offer, and prices can differ per branch.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: AI_PUBLIC_TOOL.LIST_BRANCH_DOCTORS,
    description:
      'List the doctors who actually work AT the selected branch. Call this after the branch is selected — never offer a doctor from the clinic-wide list, they may not work at this branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: AI_PUBLIC_TOOL.SELECT_SERVICE,
    description:
      'Record the service(s) the visitor chose. Each must appear in list_branch_services for the selected branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serviceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Service UUIDs from list_branch_services.',
        },
      },
      required: ['serviceIds'],
    },
  },
  {
    name: AI_PUBLIC_TOOL.SELECT_DOCTOR,
    description:
      'Record the doctor the visitor chose. Must appear in list_branch_doctors for the selected branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        staffId: {
          type: 'string',
          description: 'Doctor UUID from list_branch_doctors.',
        },
      },
      required: ['staffId'],
    },
  },
  {
    name: AI_PUBLIC_TOOL.SELECT_SLOT,
    description:
      'Record the appointment time the visitor chose. Use search_public_availability first to offer real free windows — never invent a time. The slot is re-checked against live availability when the booking is created, so a time that has since been taken will be rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        startAt: {
          type: 'string',
          description: 'Start time, ISO-8601 with timezone offset.',
        },
      },
      required: ['startAt'],
    },
  },
  {
    name: AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT,
    description:
      "Create the appointment. Call this ONLY after city, clinic, branch, service, doctor and slot have all been recorded via the select_* tools, and after you have the patient's name and phone. " +
      'You must also know their health-insurance status: ask exactly — Arabic: "هل لديك تأمين صحي؟" / English: "Do you have health insurance?" — and pass the answer as hasInsurance. ' +
      'Insured patients are never charged online and no payment link is created for them, regardless of what you say. ' +
      "Uninsured patients may receive a payment link in this tool's result when the clinic requires online payment; if `paymentLink` is present, share its details. That decision is the backend's, not yours. " +
      'Takes no clinic, branch, service, doctor or time arguments — those come from what you already recorded, so they cannot drift. ' +
      'Do not tell the visitor the booking succeeded until this tool returns success.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullName: { type: 'string', description: "The patient's full name." },
        phone: { type: 'string', description: "The patient's phone number." },
        email: { type: 'string', description: 'Optional email address.' },
        hasInsurance: {
          type: 'boolean',
          description:
            'The patient\'s confirmed answer to the health-insurance question. Omit only if you truly could not obtain one — the backend then defaults to "no insurance", and payment is collected as usual.',
        },
        notes: {
          type: 'string',
          description: 'Optional notes for the clinic.',
        },
      },
      required: ['fullName', 'phone'],
    },
  },
];

/**
 * The read-only discovery tools a public visitor also needs. Reused from the
 * shared catalogue rather than redeclared, so their schemas cannot drift.
 */
export const PUBLIC_DISCOVERY_TOOL_NAMES: string[] = [
  AI_TOOL.SEARCH_CLINICS,
  AI_TOOL.GET_CLINIC_DETAILS,
  AI_TOOL.SEARCH_PUBLIC_AVAILABILITY,
  AI_TOOL.REQUEST_HUMAN_HANDOVER,
];

export const AI_PUBLIC_BOOKING_TOOLS = PUBLIC_ONLY_TOOLS;

/** Fast membership test for the dispatcher's routing switch. */
export const PUBLIC_TOOL_NAMES = new Set<string>(Object.values(AI_PUBLIC_TOOL));

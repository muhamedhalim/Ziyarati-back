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
      'List the cities that currently have bookable clinics. Call it only when the visitor wants to book, has not said which city they are in, and no city or clinic is already recorded in the ESTABLISHED BOOKING CONTEXT — if one is, that step is done, do not repeat it. ' +
      'Then present the cities and pass the chosen one to search_clinics as `cityId`. ' +
      'Do NOT call it to answer a question ABOUT a clinic (its address, working hours, services, prices, policies or FAQs): answer those from the <knowledge> block. ' +
      'AN EMPTY `cities` LIST DOES NOT MEAN THERE ARE NO CLINICS. Cities are optional data a clinic may never have filled in, so read `bookableClinics` in the result: if it is above zero, bookable clinics exist and you must call search_clinics with no arguments and offer them. ' +
      'Only `bookableClinics: 0` means no clinic has opted in to public booking — and even that is never an answer to an informational question.',
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
      'You must also know their health-insurance status: ask a plain yes/no question, IN THE LANGUAGE THE PATIENT HAS BEEN USING (never a fixed script and never switch language for this one question) — and pass the answer as hasInsurance. ' +
      'Insured patients are never charged online and no payment link is created for them, regardless of what you say. ' +
      "Uninsured patients may receive a payment link in this tool's result when the clinic requires online payment; if `paymentLink` is present, share its `payUrl` and amount. That decision is the backend's, not yours. " +
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
            'The patient\'s answer to the health-insurance question, asked once in this turn. Omit only if you truly could not obtain one — the backend then defaults to "no insurance", and payment is collected as usual.',
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
  // Branch facts and doctor rosters. They take NO ids on this surface — both
  // resolve branch and doctor from the server-side booking session, so they
  // add read surface without adding a single argument a prompt injection
  // could aim at another clinic. Without them, "what are your hours?" and
  // "when does the doctor work?" had no tool at all and fell through to
  // <knowledge>, which most clinics never populate.
  AI_TOOL.GET_BRANCH_INFO,
  AI_TOOL.GET_DOCTOR_SCHEDULE,
  AI_TOOL.REQUEST_HUMAN_HANDOVER,
];

export const AI_PUBLIC_BOOKING_TOOLS = PUBLIC_ONLY_TOOLS;

/** Fast membership test for the dispatcher's routing switch. */
export const PUBLIC_TOOL_NAMES = new Set<string>(Object.values(AI_PUBLIC_TOOL));

/**
 * The tools that CHANGE the server-side booking context (city, clinic, branch,
 * service, doctor, slot).
 *
 * `AiExecutionService` watches for these inside the tool-calling loop: when one
 * runs, the ESTABLISHED BOOKING CONTEXT block already in the prompt is out of
 * date, so it is rebuilt from the database before the model composes its reply.
 * Without that, a `select_*` result landing mid-loop would sit next to a stale
 * block still describing the previous state — the model would be reading two
 * contradictory accounts of the same conversation, which is exactly how an
 * established clinic gets talked out of existence by a tool result.
 */
export const BOOKING_CONTEXT_MUTATING_TOOLS = new Set<string>([
  AI_TOOL.SEARCH_CLINICS,
  AI_PUBLIC_TOOL.SELECT_CLINIC,
  AI_PUBLIC_TOOL.SELECT_BRANCH,
  AI_PUBLIC_TOOL.SELECT_SERVICE,
  AI_PUBLIC_TOOL.SELECT_DOCTOR,
  AI_PUBLIC_TOOL.SELECT_SLOT,
]);

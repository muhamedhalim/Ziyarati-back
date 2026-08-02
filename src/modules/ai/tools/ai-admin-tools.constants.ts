import { AiToolDefinition } from '../providers/ai-provider.interface';
import { PERMISSION } from '../../../rbac/rbac.constants';

/**
 * Read-only Dashboard Copilot tools (the "Dashboard AI Assistant").
 *
 * Each tool is a thin, PERMISSION-GATED wrapper over an EXISTING tenant-scoped
 * service (DashboardMetricService / SubscriptionService / AiAnalyticsService /
 * AppointmentsService / CustomerService / StaffService) — no new queries, no
 * business logic. `requiredPermission` mirrors the EXACT permission slug the
 * underlying resource's own REST controller requires, so asking the assistant
 * about e.g. revenue never reveals data the caller couldn't already see on the
 * matching dashboard page. Enforced in `AiToolDispatchService` against the
 * SAME `AuthenticatedUser.permissions` array `PermissionsGuard` checks.
 */
export const AI_ADMIN_TOOL = {
  GET_DASHBOARD_KPIS: 'get_dashboard_kpis',
  GET_SUBSCRIPTION_STATUS: 'get_subscription_status',
  GET_USAGE_QUOTA: 'get_usage_quota',
  GET_APPOINTMENT_OVERVIEW: 'get_appointment_overview',
  GET_PATIENT_OVERVIEW: 'get_patient_overview',
  GET_STAFF_OVERVIEW: 'get_staff_overview',
  GET_AI_USAGE_REPORT: 'get_ai_usage_report',
  GET_AI_MONITORING_SUMMARY: 'get_ai_monitoring_summary',
} as const;

export type AiAdminToolName =
  (typeof AI_ADMIN_TOOL)[keyof typeof AI_ADMIN_TOOL];

/** Permission required for each admin tool — checked before execution. */
export const AI_ADMIN_TOOL_PERMISSION: Record<AiAdminToolName, string> = {
  [AI_ADMIN_TOOL.GET_DASHBOARD_KPIS]: PERMISSION.ANALYTICS_DASHBOARD_READ,
  [AI_ADMIN_TOOL.GET_SUBSCRIPTION_STATUS]: PERMISSION.SUBSCRIPTION_READ,
  [AI_ADMIN_TOOL.GET_USAGE_QUOTA]: PERMISSION.USAGE_READ,
  [AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW]: PERMISSION.APPOINTMENTS_READ,
  [AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW]: PERMISSION.CUSTOMERS_READ,
  [AI_ADMIN_TOOL.GET_STAFF_OVERVIEW]: PERMISSION.STAFF_READ,
  [AI_ADMIN_TOOL.GET_AI_USAGE_REPORT]: PERMISSION.AI_ANALYTICS_READ,
  [AI_ADMIN_TOOL.GET_AI_MONITORING_SUMMARY]: PERMISSION.AI_ANALYTICS_READ,
};

export const AI_ADMIN_TOOLS: AiToolDefinition[] = [
  {
    name: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS,
    description:
      'Get the clinic dashboard KPI snapshot: total revenue, total paid payments, total appointments, total patients, active conversations, AI messages and AI tokens used. Use this for "revenue", "how many patients/appointments" type questions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: AI_ADMIN_TOOL.GET_SUBSCRIPTION_STATUS,
    description:
      "Get the clinic's current subscription: plan, status, billing period and renewal date.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: AI_ADMIN_TOOL.GET_USAGE_QUOTA,
    description:
      "Get the clinic's current plan usage/quota breakdown (used, limit, remaining, exceeded) across every metered resource.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW,
    description:
      'Count appointments, optionally filtered by status and/or a date range. Use for "how many appointments today/this week" questions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          description: 'Optional appointment status filter.',
        },
        from: {
          type: 'string',
          description:
            'Optional ISO-8601 lower bound (inclusive) on start time.',
        },
        to: {
          type: 'string',
          description:
            'Optional ISO-8601 upper bound (exclusive) on start time.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW,
    description:
      "Count the clinic's patients (customers), optionally filtered by active status.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        isActive: {
          type: 'boolean',
          description: 'Optional active/inactive filter.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_ADMIN_TOOL.GET_STAFF_OVERVIEW,
    description:
      "Count the clinic's staff/doctors, optionally filtered by branch or availability.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branchId: {
          type: 'string',
          description: 'Optional branch UUID filter.',
        },
      },
      required: [],
    },
  },
  {
    name: AI_ADMIN_TOOL.GET_AI_USAGE_REPORT,
    description:
      'Get AI token usage: totals, monthly trend, and the top agents by token consumption. Optional date range.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Optional ISO-8601 lower bound.' },
        to: { type: 'string', description: 'Optional ISO-8601 upper bound.' },
      },
      required: [],
    },
  },
  {
    name: AI_ADMIN_TOOL.GET_AI_MONITORING_SUMMARY,
    description:
      'Get AI conversation health: status mix, handover rate, and resolution rate. Use for "how is the AI performing" style questions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Optional ISO-8601 lower bound.' },
        to: { type: 'string', description: 'Optional ISO-8601 upper bound.' },
      },
      required: [],
    },
  },
];

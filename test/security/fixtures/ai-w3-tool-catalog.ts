/**
 * Shared W3 (Feature 011, Phase 5) runtime-authorization fixture — T088-T104.
 *
 * Centralizes two things every W3 spec needs so none of them re-derive it by
 * hand (and so a future 27th tool or a role-permission edit is picked up by
 * every spec automatically, straight from the SAME source the dispatcher and
 * RBAC seeder use):
 *
 *  - `ALL_TOOLS`: the 26-tool catalog (9 core + 8 admin + 9 public), each
 *    tagged with its DECLARED permission (from `AI_TOOL_PERMISSION` /
 *    `AI_ADMIN_TOOL_PERMISSION`, or `null` when none exists) and whether it
 *    mutates — cross-checked against `w3-declared-vs-enforced.md` (T044).
 *  - `permissionsForPrincipal(type)`: the REAL permission array
 *    (`ROLE_PERMISSIONS[ROLE.X]`) for each of the 8 audit principal types —
 *    never a hand-typed guess, so a test asserting "manager cannot do X"
 *    fails loudly if `manager` is ever granted X in `rbac.constants.ts`
 *    instead of silently asserting a stale permission set.
 */
import type { INestApplication } from '@nestjs/common';

import {
  PERMISSION,
  PermissionSlug,
  ROLE,
  ROLE_PERMISSIONS,
} from '../../../src/rbac/rbac.constants';
import { AI_TOOL, AI_TOOL_PERMISSION } from '../../../src/modules/ai/tools/ai-tools.constants';
import {
  AI_ADMIN_TOOL,
  AI_ADMIN_TOOL_PERMISSION,
} from '../../../src/modules/ai/tools/ai-admin-tools.constants';
import { AI_PUBLIC_TOOL } from '../../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { AppointmentsService } from '../../../src/modules/appointment/appointment.service';
import { DashboardMetricService } from '../../../src/modules/analytics/dashboard-metric.service';
import { SubscriptionService } from '../../../src/modules/subscription-billing/subscription.service';
import { UsageService } from '../../../src/modules/subscription-billing/usage.service';
import { CustomerService } from '../../../src/modules/crm/customer.service';
import { StaffService } from '../../../src/modules/staff/staff.service';
import { AiAnalyticsService } from '../../../src/modules/ai/ai-analytics.service';

export type ToolCatalog = 'core' | 'admin' | 'public';

export interface ToolMeta {
  name: string;
  catalog: ToolCatalog;
  /** From the `*_PERMISSION` map, or `null` when the tool declares none (by design). */
  declaredPermission: PermissionSlug | null;
  mutating: boolean;
}

/** The 9 `ai-tools.constants.ts` (core) tools. */
export const CORE_TOOLS: ToolMeta[] = [
  { name: AI_TOOL.SEARCH_CLINICS, catalog: 'core', declaredPermission: null, mutating: false },
  { name: AI_TOOL.GET_CLINIC_DETAILS, catalog: 'core', declaredPermission: null, mutating: false },
  { name: AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, catalog: 'core', declaredPermission: null, mutating: false },
  { name: AI_TOOL.CHECK_AVAILABILITY, catalog: 'core', declaredPermission: null, mutating: false },
  { name: AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS, catalog: 'core', declaredPermission: null, mutating: false },
  {
    name: AI_TOOL.BOOK_APPOINTMENT,
    catalog: 'core',
    declaredPermission: AI_TOOL_PERMISSION[AI_TOOL.BOOK_APPOINTMENT] ?? null,
    mutating: true,
  },
  {
    name: AI_TOOL.RESCHEDULE_APPOINTMENT,
    catalog: 'core',
    declaredPermission: AI_TOOL_PERMISSION[AI_TOOL.RESCHEDULE_APPOINTMENT] ?? null,
    mutating: true,
  },
  {
    name: AI_TOOL.CANCEL_APPOINTMENT,
    catalog: 'core',
    declaredPermission: AI_TOOL_PERMISSION[AI_TOOL.CANCEL_APPOINTMENT] ?? null,
    mutating: true,
  },
  { name: AI_TOOL.REQUEST_HUMAN_HANDOVER, catalog: 'core', declaredPermission: null, mutating: true },
];

/** The 8 `ai-admin-tools.constants.ts` (Dashboard Copilot) tools — every one permission-gated. */
export const ADMIN_TOOLS: ToolMeta[] = Object.values(AI_ADMIN_TOOL).map((name) => ({
  name,
  catalog: 'admin' as const,
  declaredPermission: AI_ADMIN_TOOL_PERMISSION[name] as PermissionSlug,
  mutating: false,
}));

/** The 9 `ai-public-booking-tools.constants.ts` (anonymous) tools — none permission-gated. */
export const PUBLIC_TOOLS: ToolMeta[] = [
  { name: AI_PUBLIC_TOOL.LIST_CITIES, catalog: 'public', declaredPermission: null, mutating: false },
  { name: AI_PUBLIC_TOOL.SELECT_CLINIC, catalog: 'public', declaredPermission: null, mutating: true },
  { name: AI_PUBLIC_TOOL.SELECT_BRANCH, catalog: 'public', declaredPermission: null, mutating: true },
  { name: AI_PUBLIC_TOOL.LIST_BRANCH_SERVICES, catalog: 'public', declaredPermission: null, mutating: false },
  { name: AI_PUBLIC_TOOL.LIST_BRANCH_DOCTORS, catalog: 'public', declaredPermission: null, mutating: false },
  { name: AI_PUBLIC_TOOL.SELECT_SERVICE, catalog: 'public', declaredPermission: null, mutating: true },
  { name: AI_PUBLIC_TOOL.SELECT_DOCTOR, catalog: 'public', declaredPermission: null, mutating: true },
  { name: AI_PUBLIC_TOOL.SELECT_SLOT, catalog: 'public', declaredPermission: null, mutating: true },
  { name: AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT, catalog: 'public', declaredPermission: null, mutating: true },
];

/** All 26 tools, in catalog order — T041-T044's inventory count. */
export const ALL_TOOLS: ToolMeta[] = [...CORE_TOOLS, ...ADMIN_TOOLS, ...PUBLIC_TOOLS];

export const PERMISSION_GATED_TOOLS = ALL_TOOLS.filter((t) => t.declaredPermission !== null);
export const UNGATED_TOOLS = ALL_TOOLS.filter((t) => t.declaredPermission === null);
export const MUTATING_TOOLS = ALL_TOOLS.filter((t) => t.mutating);

export function toolMeta(name: string): ToolMeta {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`ai-w3-tool-catalog: unknown tool "${name}"`);
  return found;
}

/** The 8 audit principal types named in tasks.md / contracts/inventory.schema.md. */
export type PrincipalType =
  | 'super_admin'
  | 'owner'
  | 'manager'
  | 'receptionist'
  | 'doctor'
  | 'customer'
  | 'ai-bot'
  | 'guest';

export const ALL_PRINCIPAL_TYPES: PrincipalType[] = [
  'super_admin',
  'owner',
  'manager',
  'receptionist',
  'doctor',
  'customer',
  'ai-bot',
  'guest',
];

/**
 * The REAL permission array a principal of this type carries, read live from
 * `ROLE_PERMISSIONS` (never hand-duplicated). `super_admin` resolves the `'*'`
 * sentinel to literally every permission slug in the catalogue — the same
 * expansion `role-permissions.seed.ts` performs at seed time.
 */
export function permissionsForPrincipal(type: PrincipalType): PermissionSlug[] {
  switch (type) {
    case 'super_admin':
      return Object.values(PERMISSION);
    case 'guest':
      return [];
    case 'ai-bot':
      return ROLE_PERMISSIONS[ROLE.AI_BOT] as PermissionSlug[];
    case 'owner':
      return ROLE_PERMISSIONS[ROLE.OWNER] as PermissionSlug[];
    case 'manager':
      return ROLE_PERMISSIONS[ROLE.MANAGER] as PermissionSlug[];
    case 'receptionist':
      return ROLE_PERMISSIONS[ROLE.RECEPTIONIST] as PermissionSlug[];
    case 'doctor':
      return ROLE_PERMISSIONS[ROLE.DOCTOR] as PermissionSlug[];
    case 'customer':
      return ROLE_PERMISSIONS[ROLE.CUSTOMER] as PermissionSlug[];
  }
}

/** Whether this principal type holds the tool's declared permission. */
export function principalCanReach(type: PrincipalType, tool: ToolMeta): boolean {
  if (tool.declaredPermission === null) return type !== 'guest' ? true : false; // guest handled specially by callers (advertisement, not enforcement)
  return permissionsForPrincipal(type).includes(tool.declaredPermission);
}

/**
 * Minimal, plausible arguments for each of the 26 tools — enough to reach
 * real dispatcher logic, not necessarily to succeed end to end. Shared by any
 * spec that needs to execute the FULL 26-tool catalog for a given principal
 * (T089 guest reachability, T093 advertisement-drift).
 */
export function sampleArgsFor(name: string, seed: { tenantA: { id: string; branchId: string; staffUserId: string; customerIds: string[]; appointmentId: string } }): Record<string, unknown> {
  switch (name) {
    case AI_TOOL.SEARCH_CLINICS:
      return {};
    case AI_TOOL.GET_CLINIC_DETAILS:
      return { clinicId: seed.tenantA.id };
    case AI_TOOL.SEARCH_PUBLIC_AVAILABILITY:
      return { branchId: seed.tenantA.branchId, staffId: seed.tenantA.staffUserId, date: '2027-01-02' };
    case AI_TOOL.CHECK_AVAILABILITY:
      return { branchId: seed.tenantA.branchId, staffId: seed.tenantA.staffUserId, date: '2027-01-02' };
    case AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS:
      return {};
    case AI_TOOL.BOOK_APPOINTMENT:
      return { branchId: seed.tenantA.branchId, customerId: seed.tenantA.customerIds[0], staffId: seed.tenantA.staffUserId, startAt: '2027-01-02T10:00:00Z' };
    case AI_TOOL.RESCHEDULE_APPOINTMENT:
      return { appointmentId: seed.tenantA.appointmentId, newStartAt: '2027-01-03T10:00:00Z' };
    case AI_TOOL.CANCEL_APPOINTMENT:
      return { appointmentId: seed.tenantA.appointmentId };
    case AI_TOOL.REQUEST_HUMAN_HANDOVER:
      return {};
    case AI_PUBLIC_TOOL.LIST_CITIES:
      return {};
    case AI_PUBLIC_TOOL.SELECT_CLINIC:
      return { clinicId: seed.tenantA.id };
    case AI_PUBLIC_TOOL.SELECT_BRANCH:
      return { branchId: seed.tenantA.branchId };
    case AI_PUBLIC_TOOL.LIST_BRANCH_SERVICES:
    case AI_PUBLIC_TOOL.LIST_BRANCH_DOCTORS:
      return {};
    case AI_PUBLIC_TOOL.SELECT_SERVICE:
      return { serviceIds: ['non-existent-service'] };
    case AI_PUBLIC_TOOL.SELECT_DOCTOR:
      return { staffId: seed.tenantA.staffUserId };
    case AI_PUBLIC_TOOL.SELECT_SLOT:
      return { startAt: '2027-01-02T10:00:00Z' };
    case AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT:
      return { fullName: 'Guest Visitor', phone: '+15559990000' };
    default:
      return {}; // admin tools — args irrelevant, permission check fires first
  }
}

const FORBIDDEN_RE = /^Forbidden:/;
const NO_ACTOR_RE = /no acting user/i;

/**
 * Classifies a refusal as authorization-shaped (blocked before reaching any
 * protected read/write, on grounds of WHO the caller is) versus an ordinary
 * business/validation refusal that any properly-authorized caller could also
 * hit with bad input. `book_appointment`/`reschedule_appointment`/
 * `cancel_appointment` check `ctx.actorUserId` BEFORE the permission slug
 * (`ai-tool-dispatch.service.ts:453-464,966-977,1025-1037`) — for a guest
 * (who has no acting user AND no permissions) the "no acting user" gate fires
 * first, so the permission check is never actually reached. Both are still
 * genuine authorization gates (identity-binding and RBAC respectively), so
 * both count as `auth_blocked` — the DISTINCT reason is recorded for
 * evidence, since it is a real, observed difference in WHICH gate stopped
 * the call.
 */
export function classifyRefusal(error: string | undefined): { bucket: 'auth_blocked' | 'other_refusal'; reason?: 'no_acting_user' | 'permission' } {
  if (!error) return { bucket: 'other_refusal' };
  if (NO_ACTOR_RE.test(error)) return { bucket: 'auth_blocked', reason: 'no_acting_user' };
  if (FORBIDDEN_RE.test(error)) return { bucket: 'auth_blocked', reason: 'permission' };
  return { bucket: 'other_refusal' };
}

/**
 * Maps each of the 11 permission-gated tools to its backing-service spy
 * target — the exact `file:line` call sites recorded in `w3-tools-core.md` /
 * `w3-tools-admin.md`. Shared so every W3 spec that needs "provably absent
 * side effect" (T088, T090, T091) uses the SAME mapping rather than
 * re-deriving it (and risking one spec spying the wrong method).
 */
export function backingServiceSpy(app: INestApplication, toolName: string): jest.SpyInstance {
  switch (toolName) {
    case AI_TOOL.BOOK_APPOINTMENT:
      return jest.spyOn(app.get(AppointmentsService), 'create');
    case AI_TOOL.RESCHEDULE_APPOINTMENT:
      return jest.spyOn(app.get(AppointmentsService), 'reschedule');
    case AI_TOOL.CANCEL_APPOINTMENT:
      return jest.spyOn(app.get(AppointmentsService), 'cancel');
    case AI_ADMIN_TOOL.GET_DASHBOARD_KPIS:
      return jest.spyOn(app.get(DashboardMetricService), 'getMetrics');
    case AI_ADMIN_TOOL.GET_SUBSCRIPTION_STATUS:
      return jest.spyOn(app.get(SubscriptionService), 'getCurrent');
    case AI_ADMIN_TOOL.GET_USAGE_QUOTA:
      return jest.spyOn(app.get(UsageService), 'getBreakdown');
    case AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW:
      return jest.spyOn(app.get(AppointmentsService), 'findAll');
    case AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW:
      return jest.spyOn(app.get(CustomerService), 'list');
    case AI_ADMIN_TOOL.GET_STAFF_OVERVIEW:
      return jest.spyOn(app.get(StaffService), 'findAll');
    case AI_ADMIN_TOOL.GET_AI_USAGE_REPORT:
      return jest.spyOn(app.get(AiAnalyticsService), 'usage');
    case AI_ADMIN_TOOL.GET_AI_MONITORING_SUMMARY:
      return jest.spyOn(app.get(AiAnalyticsService), 'conversations');
    default:
      throw new Error(`ai-w3-tool-catalog: no backing-service spy mapping for gated tool "${toolName}"`);
  }
}

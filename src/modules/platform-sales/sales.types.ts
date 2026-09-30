import type {
  SalesAssignmentEndReason,
  SalesAssignmentKind,
} from '../../entities/Sales/SalesClinicAssignment';
import type {
  SalesBonusType,
  SalesMetric,
} from '../../entities/Sales/SalesTarget';
import type { PlatformStaffSummary } from '../platform-staff/platform-staff.service';
import type {
  SalesImportRowStatus,
  SalesSkipReason,
} from './platform-sales.constants';
import type { SalesPhase } from './sales-progress.util';

/** A verified sales employee — what `requireEmployee` returns. */
export interface SalesEmployeeRef {
  id: string;
  email: string | null;
  fullName: string | null;
  phone: string | null;
  isActive: boolean;
}

export interface Paged<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/** A sales employee as listed: the staff summary plus portfolio stats. */
export interface SalesEmployeeListItem extends PlatformStaffSummary {
  assignedCount: number;
  lastActivityAt: string | null;
  /** Targets set for the requested month, with progress (empty when none). */
  targets: SalesTargetBrief[];
  /**
   * What the bonus rules of those targets would pay for the progress so far, per
   * currency. A projection — the approved amount lives on the bonus record.
   */
  bonusPreview: SalesBonusAmount[];
}

export interface SalesEmployeeDetail extends SalesEmployeeListItem {
  /** Assignments that have been closed (unassigned / reassigned / transferred). */
  endedCount: number;
}

export interface SalesOverview {
  period: string;
  periodMonth: string;
  employees: number;
  activeEmployees: number;
  /** Clinics with an active sales owner (deleted clinics excluded). */
  assignedClinics: number;
  /** Assignable clinics (not deleted, not REJECTED) with no active owner. */
  unassignedClinics: number;
  billingMode: string;
  /** Targets set for the period across the team (active employees only for an open month). */
  targetsSet: number;
  /** Of those, how many are at or ahead of pace (a closed month: reached). */
  onTrack: number;
  byMetric: SalesOverviewMetric[];
  /**
   * Whether the platform is in PAID billing mode. While false, subscription
   * revenue and paid-conversion figures cannot accumulate, and the UI says so.
   */
  billingLive: boolean;
}

export interface SalesClinicBasics {
  id: string;
  name: string;
  slug: string;
  contactEmail: string | null;
  contactPhone: string | null;
  isActive: boolean;
  approvalStatus: string;
  createdAt: string | null;
  subscriptionStatus: string | null;
  planName: string | null;
}

/** One row of the clinic picker. */
export interface SalesPickerClinic extends SalesClinicBasics {
  /** The clinic's CURRENT sales owner, if any. */
  owner: {
    employeeId: string;
    name: string | null;
    kind: SalesAssignmentKind;
    assignedAt: string | null;
  } | null;
}

/** One row of an employee's portfolio. */
export interface SalesPortfolioItem {
  assignmentId: string;
  clinic: SalesClinicBasics;
  kind: SalesAssignmentKind;
  assignedAt: string | null;
  endedAt: string | null;
  endReason: SalesAssignmentEndReason | null;
  note: string | null;
  /** Latest activity this employee logged for the clinic. */
  lastActivityAt: string | null;
}

export interface SalesAssignSkipped {
  tenantId: string;
  reason: SalesSkipReason;
  /** Present for `assigned_to_other`. */
  ownerEmployeeId?: string;
}

export interface SalesAssignResult {
  requested: number;
  assigned: number;
  /** Subset of `assigned` that took the clinic over from another employee. */
  reassigned: number;
  skipped: SalesAssignSkipped[];
}

export type SalesEndSkipReason = 'not_found' | 'already_ended';

export interface SalesEndResult {
  requested: number;
  ended: number;
  skipped: Array<{ assignmentId: string; reason: SalesEndSkipReason }>;
}

export type SalesTransferSkipReason =
  | 'not_owned_by_employee'
  | 'concurrent_assignment';

export interface SalesTransferResult {
  requested: number;
  transferred: number;
  skipped: Array<{ assignmentId: string; reason: SalesTransferSkipReason }>;
  /** Active clinics the source employee still owns (non-zero after a capped `all`). */
  remaining: number;
}

export interface SalesClinicHistoryItem {
  assignmentId: string;
  employee: { id: string; name: string | null; email: string | null };
  kind: SalesAssignmentKind;
  assignedAt: string | null;
  endedAt: string | null;
  endReason: SalesAssignmentEndReason | null;
  note: string | null;
}

// ─────────────────────────────── Targets ───────────────────────────────── //

export interface SalesBonusRule {
  type: SalesBonusType;
  thresholdPct: number | null;
  amount: number | null;
  percent: number | null;
  currency: string | null;
}

/** Progress of one metric for one employee in one month. */
export interface SalesMetricRow {
  employeeId: string;
  metric: SalesMetric;
  /** 'YYYY-MM' */
  period: string;
  /** `null` while no target is set (progress is still reported). */
  targetId: string | null;
  version: number | null;
  target: number | null;
  /** Revenue only: the target's currency, or the platform default when no target is set. */
  currency: string | null;
  achieved: number;
  remaining: number | null;
  /** Uncapped; `null` when there is no target. */
  percentage: number | null;
  isCompleted: boolean;
  /** Linear pace for the month, 0–100. */
  expectedPercentage: number;
  onTrack: boolean | null;
  bonusRule: SalesBonusRule | null;
  /** The target's bonus is approved: it can no longer be changed. */
  locked: boolean;
  /** Revenue collected in other currencies — not counted toward this target. */
  excludedCurrencies: Array<{ currency: string; amount: number }>;
  updatedAt: string | null;
}

/** The slim per-metric progress shown in the team table. */
export interface SalesTargetBrief {
  metric: SalesMetric;
  target: number;
  currency: string | null;
  achieved: number;
  percentage: number | null;
  isCompleted: boolean;
  /** Linear pace for the month, 0–100 (100 once the month has closed). */
  expectedPercentage: number;
  onTrack: boolean | null;
}

export interface SalesTargetMonth {
  period: string;
  phase: SalesPhase;
  metrics: SalesMetricRow[];
}

export interface SalesTargetsResponse {
  employeeId: string;
  from: string;
  to: string;
  /** Platform billing currency — the default for a new revenue target. */
  defaultCurrency: string;
  currencies: string[];
  billingLive: boolean;
  months: SalesTargetMonth[];
}

export interface SalesTargetRevisionItem {
  id: string;
  targetId: string;
  period: string;
  metric: SalesMetric;
  revision: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  changedBy: { id: string; name: string | null } | null;
  createdAt: string | null;
}

export interface SalesOverviewMetric {
  metric: SalesMetric;
  /** Revenue is reported per currency (no FX); `null` for the count metrics. */
  currency: string | null;
  /** Employees with a target for this metric. */
  targets: number;
  /** Sum of those targets. */
  target: number;
  /** Achieved by those same employees (an employee without a target does not inflate it). */
  achieved: number;
  percentage: number | null;
  onTrack: number;
}

// ─────────────────────────────── Bonuses ───────────────────────────────── //

export interface SalesBonusAmount {
  currency: string;
  amount: number;
}

export type SalesBonusStatusValue = 'approved' | 'paid' | 'void';

/** An approved bonus: the frozen calculation plus its lifecycle. Immutable except for status. */
export interface SalesBonusRecordItem {
  id: string;
  targetId: string;
  period: string;
  metric: SalesMetric;
  targetValue: number;
  achievedValue: number;
  achievementPct: number;
  /** The rule as it stood at approval, plus what the calculation decided. */
  rule: Record<string, unknown>;
  amount: number;
  currency: string | null;
  status: SalesBonusStatusValue;
  computedAt: string | null;
  approvedBy: { id: string; name: string | null } | null;
  approvedAt: string | null;
  paidMarkedBy: { id: string; name: string | null } | null;
  paidMarkedAt: string | null;
  voidReason: string | null;
  voidedBy: { id: string; name: string | null } | null;
  voidedAt: string | null;
}

/**
 *  - `no_rule`  the target has no bonus rule — nothing to approve
 *  - `open`     the month is still running: a projection only
 *  - `ready`    the month has closed and no bonus is approved yet
 *  - `approved` / `paid`  a live record exists
 */
export type SalesBonusState = 'no_rule' | 'open' | 'ready' | 'approved' | 'paid';

/** One metric's bonus for one month: what the rule would pay, and the live record if any. */
export interface SalesBonusPreviewItem {
  metric: SalesMetric;
  period: string;
  targetId: string;
  /** The target's version — send it back as `expectedVersion` when approving. */
  version: number;
  target: number;
  achieved: number;
  percentage: number | null;
  /** The target's currency (revenue) — `null` for the count metrics. */
  currency: string | null;
  rule: SalesBonusRule | null;
  applicable: boolean;
  thresholdMet: boolean;
  /** What the rule pays for the CURRENT progress. */
  amount: number;
  bonusCurrency: string | null;
  excludedCurrencies: Array<{ currency: string; amount: number }>;
  state: SalesBonusState;
  /** The approved or paid record, if any. */
  record: SalesBonusRecordItem | null;
  /** Earlier records that were voided (kept for the history). */
  voidedCount: number;
}

export interface SalesBonusMonth {
  employeeId: string;
  period: string;
  phase: SalesPhase;
  billingLive: boolean;
  items: SalesBonusPreviewItem[];
}

export interface SalesBonusList extends Paged<SalesBonusRecordItem> {
  /** Lifetime figures for the employee, per currency — independent of the page filters. */
  totals: { owed: SalesBonusAmount[]; paid: SalesBonusAmount[] };
}

// ─────────────────────────────── Activities ────────────────────────────── //

export interface SalesActivityItem {
  id: string;
  type: string;
  occurredAt: string | null;
  /** The clinic, when the activity concerned one on the platform. */
  clinic: { id: string; name: string; slug: string } | null;
  /** The prospect, when it did not. */
  prospectName: string | null;
  outcome: string | null;
  note: string | null;
  /** `admin_manual` in v1 — a future rep console writes `self`. */
  source: string;
  recordedBy: { id: string; name: string | null } | null;
  createdAt: string | null;
}

// ─────────────────────────── Excel import / export ─────────────────────────── //

export interface SalesImportRow {
  /** 1-based spreadsheet row (the header is row 1). */
  row: number;
  status: SalesImportRowStatus;
  /** What the row asked for: its slug, else its id. */
  identifier: string;
  /** The cells as given (trimmed, lower-cased), so failed rows can be fixed and re-uploaded. */
  slug: string | null;
  id: string | null;
  clinic: { id: string; name: string; slug: string } | null;
  kind: SalesAssignmentKind;
  note: string | null;
  /** The current owner, when another employee has the clinic. */
  owner: { employeeId: string; name: string | null } | null;
  message: string | null;
}

export interface SalesImportPreview {
  totalRows: number;
  /** Rows per status; every status is present (0 when none). */
  counts: Record<SalesImportRowStatus, number>;
  /** Rows a commit would apply (`will_assign` + `will_reassign`). */
  willApply: number;
  rows: SalesImportRow[];
}

export interface SalesImportResult {
  totalRows: number;
  assigned: number;
  /** Subset of `assigned` that took the clinic over from another employee. */
  reassigned: number;
  /** Rows that were already this employee's — no-ops, not failures. */
  alreadyYours: number;
  /** Rows not applied (`errors.length`). */
  skipped: number;
  errors: SalesImportRow[];
}

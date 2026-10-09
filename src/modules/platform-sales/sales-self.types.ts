import type {
  Paged,
  SalesActivityItem,
  SalesBonusAmount,
  SalesBonusMonth,
  SalesBonusPreviewItem,
  SalesBonusRecordItem,
  SalesBonusRule,
  SalesMetricRow,
  SalesPortfolioItem,
  SalesTargetBrief,
  SalesTargetsResponse,
} from './sales.types';

/**
 * What a sales rep sees of THEIR OWN data (`/platform/sales/me/**`).
 *
 * Each type is the admin shape with the admin-only fields removed, so adding a
 * field to an admin type can never leak it to a rep by accident: the self
 * service builds these explicitly rather than passing admin objects through.
 *
 * Hidden on purpose: assignment notes, target revision history and reasons,
 * who approved / paid / voided a bonus, a void reason, voided records, the
 * invitation state, other roles, and the admin that recorded an activity.
 */

export interface SalesSelfProfile {
  id: string;
  email: string | null;
  fullName: string | null;
  phone: string | null;
  /** The month the targets below belong to (`YYYY-MM`). */
  period: string;
  assignedCount: number;
  lastActivityAt: string | null;
  targets: SalesTargetBrief[];
  bonusPreview: SalesBonusAmount[];
}

export type SalesSelfPortfolioItem = Omit<SalesPortfolioItem, 'note'>;

export type SalesSelfMetricRow = Omit<SalesMetricRow, 'employeeId' | 'targetId' | 'version'>;

export interface SalesSelfTargetMonth {
  period: string;
  phase: SalesTargetsResponse['months'][number]['phase'];
  metrics: SalesSelfMetricRow[];
}

export interface SalesSelfTargets {
  from: string;
  to: string;
  billingLive: boolean;
  months: SalesSelfTargetMonth[];
}

export interface SalesSelfBonusRecord {
  id: string;
  period: string;
  metric: SalesBonusRecordItem['metric'];
  targetValue: number;
  achievedValue: number;
  achievementPct: number;
  amount: number;
  currency: string | null;
  status: Exclude<SalesBonusRecordItem['status'], 'void'>;
  approvedAt: string | null;
  paidMarkedAt: string | null;
}

export interface SalesSelfBonusPreviewItem
  extends Pick<
    SalesBonusPreviewItem,
    | 'metric'
    | 'period'
    | 'target'
    | 'achieved'
    | 'percentage'
    | 'currency'
    | 'applicable'
    | 'thresholdMet'
    | 'amount'
    | 'bonusCurrency'
    | 'excludedCurrencies'
    | 'state'
  > {
  rule: SalesBonusRule | null;
  record: SalesSelfBonusRecord | null;
}

export interface SalesSelfBonusMonth {
  period: string;
  phase: SalesBonusMonth['phase'];
  billingLive: boolean;
  items: SalesSelfBonusPreviewItem[];
}

export interface SalesSelfBonusList extends Paged<SalesSelfBonusRecord> {
  totals: { owed: SalesBonusAmount[]; paid: SalesBonusAmount[] };
}

export type SalesSelfActivityItem = Omit<SalesActivityItem, 'recordedBy'>;

/**
 * Support Tickets constants.
 *
 * Centralises the enum-like value sets (category/priority/status) and the
 * sortable-column whitelist so untrusted input can never reach the ORM order
 * clause, matching the Service Catalog convention.
 */

export const TICKET_CATEGORIES = ['technical', 'administrative', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'waiting_for_tenant',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses that represent a "closed out" ticket — used to derive KPI counts. */
export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ['resolved', 'closed'];

export const TICKET_EVENT_TYPES = [
  'STATUS_CHANGED',
  'PRIORITY_CHANGED',
  'NOTE_ADDED',
  /** Bidirectional, clinic-visible reply — always internal_only=false, from either side. */
  'REPLY',
] as const;
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

/** Statuses Platform Customer Service may set via triage — never 'closed' (super_admin only). */
export const PLATFORM_TRIAGE_STATUSES: readonly TicketStatus[] = [
  'open',
  'in_progress',
  'waiting_for_tenant',
  'resolved',
];

/** Statuses a reply (either side) may be posted on — a closed ticket is finished. */
export const REPLYABLE_TICKET_STATUSES: readonly TicketStatus[] = TICKET_STATUSES.filter(
  (s) => s !== 'closed',
);

/** Columns the ticket list may be ordered by (tenant + platform lists). */
export const TICKET_SORTABLE_FIELDS = [
  'created_at',
  'updated_at',
  'priority',
  'status',
  'ticket_number',
] as const;
export type TicketSortField = (typeof TICKET_SORTABLE_FIELDS)[number];

export const DEFAULT_TICKET_SORT_FIELD: TicketSortField = 'created_at';
export const DEFAULT_TICKET_SORT_ORDER: 'ASC' | 'DESC' = 'DESC';

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  technical: 'Technical issue',
  administrative: 'Administrative issue',
  other: 'Other',
};

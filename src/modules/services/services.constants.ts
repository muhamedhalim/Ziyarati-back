/**
 * Service Catalog constants.
 *
 * Centralises the whitelist of sortable columns so the query DTO and the service
 * layer agree on exactly one set — and untrusted `sortBy` input can never reach
 * the ORM order clause.
 */

/** Columns the service list may be ordered by. */
export const SERVICE_SORTABLE_FIELDS = [
  'name',
  'base_price',
  'duration_minutes',
  'created_at',
] as const;

export type ServiceSortField = (typeof SERVICE_SORTABLE_FIELDS)[number];

/** Default ordering when the caller does not specify one. */
export const DEFAULT_SERVICE_SORT_FIELD: ServiceSortField = 'created_at';
export const DEFAULT_SORT_ORDER: 'ASC' | 'DESC' = 'DESC';

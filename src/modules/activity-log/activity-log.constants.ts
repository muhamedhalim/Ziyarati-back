/**
 * Spec 014 (Clinic Platform Completion) — T191 (US14, F14). Pagination
 * defaults/ceilings for the clinic-facing Activity UI. Mirrors
 * `platform-support.constants.ts`'s reasoning: an unbounded scan of
 * `audit_logs` for a clinic with years of history is both a performance
 * hazard (FR-U012) and more than an interactive screen needs.
 */
export const ACTIVITY_LOG_PAGE_SIZE = 20;

/** Hard ceiling on the requested page size. */
export const ACTIVITY_LOG_MAX_PAGE_SIZE = 100;

/** Matches `audit_logs.entity_label`'s `varchar(160)`. */
export const ACTIVITY_ENTITY_LABEL_MAX = 160;

/**
 * Shortest `q` that reaches the database. One character matches a large
 * fraction of any clinic's history, so the result would be neither useful
 * nor cheap; two is where a trigram index starts being selective (a trigram
 * is three characters, so Postgres degrades a 1-2 char pattern to a scan
 * regardless). Applied to BOTH the list search and suggestions so the two
 * never disagree about what counts as a search.
 */
export const ACTIVITY_SEARCH_MIN_LENGTH = 2;

/**
 * Hard ceiling on suggestions returned per request. Deliberately small: a
 * typeahead list is read at a glance, and an unbounded suggestion query over
 * an audit table is the exact shape of an accidental full scan.
 */
export const ACTIVITY_SUGGESTION_LIMIT = 8;

/**
 * Rows the suggestions query is allowed to consider per source before
 * ranking. Bounds the work regardless of how much history a tenant has —
 * suggestions are a convenience, not an exhaustive index.
 */
export const ACTIVITY_SUGGESTION_SCAN_LIMIT = 200;

/**
 * Spec 014 (Clinic Platform Completion) — Phase 10 (US8, FR-S002/FR-S003, R8).
 *
 * The CLOSED rule vocabulary a `CustomerSegment.rules` array may reference.
 * `SegmentField` values are the only thing a caller may name — each maps,
 * server-side only (see `SegmentQueryBuilder`), to a real column/subquery.
 * A field name that isn't a member of this enum is rejected as a 400 before
 * it ever reaches a query; this enum is the structural defence against
 * identifier injection, not input sanitization.
 */
export enum SegmentField {
  LAST_APPOINTMENT_AT = 'LAST_APPOINTMENT_AT',
  APPOINTMENT_COUNT = 'APPOINTMENT_COUNT',
  APPOINTMENT_STATUS = 'APPOINTMENT_STATUS',
  SERVICE_BOOKED = 'SERVICE_BOOKED',
  BRANCH_ATTENDED = 'BRANCH_ATTENDED',
  CUSTOMER_TAG = 'CUSTOMER_TAG',
  BIRTH_DATE_IN_PERIOD = 'BIRTH_DATE_IN_PERIOD',
  MARKETING_CONSENT = 'MARKETING_CONSENT',
  MESSAGING_OPTED_OUT = 'MESSAGING_OPTED_OUT',
  CUSTOMER_CREATED_AT = 'CUSTOMER_CREATED_AT',
  CUSTOMER_ACTIVE = 'CUSTOMER_ACTIVE',
}

export enum SegmentOperator {
  EQUALS = 'EQUALS',
  GREATER_THAN = 'GREATER_THAN',
  LESS_THAN = 'LESS_THAN',
  BEFORE = 'BEFORE',
  AFTER = 'AFTER',
  WITHIN_DAYS = 'WITHIN_DAYS',
  IS_TRUE = 'IS_TRUE',
  IS_FALSE = 'IS_FALSE',
  CONTAINS = 'CONTAINS',
}

/** The operators each field accepts — also enforced server-side, never trusted from the caller. */
export const SEGMENT_FIELD_OPERATORS: Record<SegmentField, SegmentOperator[]> =
  {
    [SegmentField.LAST_APPOINTMENT_AT]: [
      SegmentOperator.BEFORE,
      SegmentOperator.AFTER,
    ],
    [SegmentField.APPOINTMENT_COUNT]: [
      SegmentOperator.EQUALS,
      SegmentOperator.GREATER_THAN,
      SegmentOperator.LESS_THAN,
    ],
    [SegmentField.APPOINTMENT_STATUS]: [SegmentOperator.EQUALS],
    [SegmentField.SERVICE_BOOKED]: [SegmentOperator.CONTAINS],
    [SegmentField.BRANCH_ATTENDED]: [SegmentOperator.CONTAINS],
    [SegmentField.CUSTOMER_TAG]: [SegmentOperator.CONTAINS],
    [SegmentField.BIRTH_DATE_IN_PERIOD]: [SegmentOperator.WITHIN_DAYS],
    [SegmentField.MARKETING_CONSENT]: [
      SegmentOperator.IS_TRUE,
      SegmentOperator.IS_FALSE,
    ],
    [SegmentField.MESSAGING_OPTED_OUT]: [
      SegmentOperator.IS_TRUE,
      SegmentOperator.IS_FALSE,
    ],
    [SegmentField.CUSTOMER_CREATED_AT]: [
      SegmentOperator.BEFORE,
      SegmentOperator.AFTER,
    ],
    [SegmentField.CUSTOMER_ACTIVE]: [
      SegmentOperator.IS_TRUE,
      SegmentOperator.IS_FALSE,
    ],
  };

export type SegmentMatch = 'ALL' | 'ANY';

export interface SegmentRule {
  field: SegmentField;
  op: SegmentOperator;
  value?: string | number | boolean;
}

export const SEGMENT_PREVIEW_SAMPLE_SIZE = 25;
export const SEGMENT_RESOLVE_PAGE_SIZE = 500;

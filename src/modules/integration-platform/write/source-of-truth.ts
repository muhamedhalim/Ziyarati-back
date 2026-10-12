import { createHash } from 'node:crypto';

import { AppError, ErrorCode } from '../../../common/errors';

import {
  CONFLICT_POLICY,
  ConflictPolicy,
  INTEGRATION_RESOURCE,
  IntegrationResource,
} from '../integration-platform.constants';

/**
 * Source-of-truth & protected-field engine (pure, side-effect-free).
 *
 * This is the security core of the two-way write pipeline. Anything an external
 * clinic system sends is UNTRUSTED: it must never be able to set an internal id,
 * a tenant/ownership field, a payment/settlement/fee field, an audit field, or
 * (for staff) roles/permissions/credentials — regardless of the connection's
 * conflict policy. Enforcement is intentionally a STRICT REJECT rather than a
 * silent strip, so a misbehaving or malicious integration surfaces the problem
 * instead of quietly having fields ignored.
 *
 * The allowlist per resource names EXACTLY the external-writable fields; the
 * protected list names fields that, if present in an external payload, cause a
 * 422. Everything not on the allowlist is simply ignored (unknown fields), but
 * a protected field is an active attempt at mass assignment and is rejected.
 */

/** Fields an external system MAY set, mapped 1:1 onto the domain create/update DTOs. */
export const EXTERNAL_WRITABLE_FIELDS: Record<IntegrationResource, readonly string[]> = {
  [INTEGRATION_RESOURCE.CUSTOMER]: [
    'full_name',
    'phone',
    'email',
    'gender',
    'date_of_birth',
    'source',
    'marketing_opt_in',
    'is_active',
  ],
  [INTEGRATION_RESOURCE.SERVICE]: [
    'name',
    'description',
    'durationMinutes',
    'pricingType',
    'basePrice',
    'isActive',
    'categoryId',
  ],
  // Staff: PROFILE + booking-preference data only, named to match UpdateStaffDto.
  // Identity, the linked user account, roles, permissions, access state,
  // credentials, commissions, payouts and ratings are platform-controlled and
  // never importable. A StaffProfile is bound to ONE user for life, so an
  // integration can never create, re-link, or provision an account (see the
  // staff adapter: update/link only, never create).
  [INTEGRATION_RESOURCE.STAFF]: [
    'title',
    'bio',
    'isAvailableForBooking',
    'bookingBufferMinutes',
  ],
  // Appointments go exclusively through the appointment LIFECYCLE service
  // (create/reschedule/cancel), which validates every reference inside a
  // transaction and re-checks real availability. Names match CreateAppointmentDto.
  // `currency` is deliberately EXCLUDED (financial) even though the DTO accepts
  // it, and status/payment/settlement fields are protected below.
  [INTEGRATION_RESOURCE.APPOINTMENT]: [
    'startAt',
    'endAt',
    'staffId',
    'customerId',
    'branchId',
    'serviceIds',
    'notes',
  ],
};

/**
 * Fields that must NEVER appear in an external payload. Present here for defense
 * in depth and for a precise 422 — even though unknown fields are ignored,
 * naming a protected field is treated as an explicit mass-assignment attempt.
 * The GLOBAL set applies to every resource; the per-resource set adds domain
 * specifics.
 */
const GLOBAL_PROTECTED_FIELDS: readonly string[] = [
  'id',
  'tenant',
  'tenantId',
  'tenant_id',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
  'deleted_at',
  'deletedAt',
  'version',
  // Financial / platform-owned — never externally writable on any resource.
  'total_amount',
  'totalAmount',
  'currency',
  'payment_status',
  'paymentStatus',
  'settlement_status',
  'settlementStatus',
  'platform_fee',
  'platformFee',
];

const RESOURCE_PROTECTED_FIELDS: Record<IntegrationResource, readonly string[]> = {
  [INTEGRATION_RESOURCE.CUSTOMER]: ['whatsapp_id', 'whatsapp_name'],
  [INTEGRATION_RESOURCE.SERVICE]: [],
  [INTEGRATION_RESOURCE.STAFF]: [
    // Account identity + linkage — a profile is bound to one user for life.
    'user',
    'userId',
    'user_id',
    'email',
    'is_active',
    'isActive',
    // Authorization + credentials.
    'roles',
    'role',
    'permissions',
    'password',
    'password_hash',
    'dashboard_access',
    'dashboardAccess',
    // Money + reputation — platform-owned.
    'commission',
    'commission_rate',
    'commissions',
    'payout',
    'payouts',
    'rating',
    'ratings',
    // Internal storage/audit.
    'avatar_url',
    'avatarUrl',
    'avatar_storage_key',
    'avatarStorageKey',
  ],
  [INTEGRATION_RESOURCE.APPOINTMENT]: [
    // Lifecycle + ownership — only the lifecycle service may move these.
    'status',
    'booked_by',
    'bookedBy',
    'cancelled_by',
    'cancelledBy',
    'rescheduled_by',
    'rescheduledBy',
    'slot',
    'source',
    // Money / settlement — platform-owned (global list also covers most of these).
    'refund_amount',
    'refundAmount',
    'transaction_id',
    'transactionId',
    'provider_reference',
    'providerReference',
    'payment_id',
    'paymentId',
  ],
};

export function protectedFieldsFor(resource: IntegrationResource): Set<string> {
  return new Set<string>([
    ...GLOBAL_PROTECTED_FIELDS,
    ...RESOURCE_PROTECTED_FIELDS[resource],
  ]);
}

export interface SanitizedInput {
  /** Only the allowlisted, external-writable fields (safe to map onto a DTO). */
  clean: Record<string, unknown>;
  /** Allowlisted fields that were actually provided (used for conflict diffing). */
  providedFields: string[];
}

/**
 * Validates and narrows an external payload for a resource.
 *
 * Throws 422 if the payload explicitly carries a platform-protected field.
 * Otherwise returns only the allowlisted fields; unknown/unrecognised fields are
 * dropped silently (they are not an attack, just noise).
 */
export function sanitizeExternalInput(
  resource: IntegrationResource,
  raw: Record<string, unknown> | undefined | null,
): SanitizedInput {
  const input = raw && typeof raw === 'object' ? raw : {};
  const protectedSet = protectedFieldsFor(resource);

  const violations = Object.keys(input).filter((k) => protectedSet.has(k));
  if (violations.length > 0) {
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message:
        'The payload contains platform-protected fields that cannot be set by an integration',
      publicContext: { protectedFields: violations.sort() },
    });
  }

  const allow = new Set(EXTERNAL_WRITABLE_FIELDS[resource]);
  const clean: Record<string, unknown> = {};
  const providedFields: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (allow.has(key) && value !== undefined) {
      clean[key] = value;
      providedFields.push(key);
    }
  }
  return { clean, providedFields };
}

export interface ConflictDecision {
  /** Whether the incoming external values should be applied to the platform record. */
  apply: boolean;
  /** Whether a conflict must be recorded/reported for manual review. */
  report: boolean;
  /** The allowlisted fields whose incoming value differs from the current record. */
  changedFields: string[];
}

export interface ConflictOptions {
  /**
   * True when the platform record is byte-for-byte what the integration last
   * wrote (its stored baseline fingerprint matches the current view). Nobody on
   * the clinic side has changed it since, so there is nothing to protect and
   * `reject_and_report` may apply the partner's update. Absent/false (no
   * baseline, or the record moved on) keeps the conservative behaviour.
   */
  platformUntouched?: boolean;
}

/**
 * Stable fingerprint of an allowlisted comparable view. Stored on the id
 * mapping after every integration-applied write so a later update can tell
 * "the clinic changed this record" apart from "only this integration ever
 * touched it". One-way (SHA-256) — no field value is persisted.
 */
export function viewFingerprint(view: Record<string, unknown>): string {
  const canon = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return JSON.stringify(v.map((x) => String(x)).sort());
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const body = Object.keys(view)
    .sort()
    .map((k) => `${k}=${canon(view[k])}`)
    .join('\u0001');
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Given the connection's conflict policy and a diff between the incoming external
 * values and the current platform record, decides whether to apply the change.
 *
 * - external_wins  → apply the external values (still only allowlisted fields).
 * - platform_wins  → keep the platform record; do not apply.
 * - reject_and_report → do not apply and flag for manual review (HTTP 409 at the
 *   API) — UNLESS the platform record is still exactly what this integration
 *   last wrote (`opts.platformUntouched`), in which case there is no competing
 *   change and the update is applied.
 *
 * A policy can only ever choose among ALLOWLISTED fields — it is structurally
 * incapable of touching a protected field, because `changed` is computed from
 * the already-sanitized `clean` object.
 */
export function decideConflict(
  policy: ConflictPolicy,
  clean: Record<string, unknown>,
  current: Record<string, unknown>,
  opts: ConflictOptions = {},
): ConflictDecision {
  const changedFields = Object.keys(clean).filter(
    (k) => !valuesEqual(clean[k], current[k]),
  );

  if (changedFields.length === 0) {
    return { apply: false, report: false, changedFields };
  }

  switch (policy) {
    case CONFLICT_POLICY.EXTERNAL_WINS:
      return { apply: true, report: false, changedFields };
    case CONFLICT_POLICY.PLATFORM_WINS:
      return { apply: false, report: false, changedFields };
    case CONFLICT_POLICY.REJECT_AND_REPORT:
    default:
      if (opts.platformUntouched) return { apply: true, report: false, changedFields };
      return { apply: false, report: true, changedFields };
  }
}

/** Loose equality for scalar field comparison (numbers vs decimal-strings, dates, etc.). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Id lists (e.g. appointment serviceIds) are SETS: order and duplicates are not a change.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const sa = [...new Set(a.map((x) => String(x)))].sort();
    const sb = [...new Set(b.map((x) => String(x)))].sort();
    return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
  }
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as string).getTime() === new Date(b as string).getTime();
  }
  // Decimal columns surface as strings (e.g. "80.00"); compare numerically when
  // both sides are non-empty numbers so `80` and `"80.00"` are not a conflict.
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa !== '' && sb !== '') {
    const na = Number(sa);
    const nb = Number(sb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return sa === sb;
}

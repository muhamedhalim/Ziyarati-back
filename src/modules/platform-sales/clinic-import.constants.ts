import type { UploadPolicy } from '../storage/storage.constants';

/**
 * Platform clinic import (sales console): creates NEW clinics from an `.xlsx`.
 *
 * Unlike the assignment import, every row here is a multi-table write (tenant,
 * settings, approval event, owner user, role link, optional sales assignment)
 * and the owner password is bcrypt-hashed per row, so the file is capped far
 * lower and the commit runs one transaction per clinic.
 */

export const CLINIC_IMPORT_UPLOAD_POLICY: UploadPolicy = {
  name: 'Excel clinic import',
  allowedTypes: [
    {
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extensions: ['xlsx'],
    },
  ],
  requireMagicBytes: true,
  requireExtensionMatch: true,
};

/** Data rows one import may carry. */
export const CLINIC_IMPORT_MAX_ROWS = 200;

/** Hard cap on the uploaded file (200 rows of text is a few tens of KB). */
export const CLINIC_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** Physical worksheet rows we are willing to iterate (formatting can inflate `rowCount`). */
export const CLINIC_IMPORT_SCAN_ROW_CEILING = CLINIC_IMPORT_MAX_ROWS * 20 + 1;

/** Field length caps — the narrowest of `CreateTenantDto` / `RegisterOwnerDto` / the columns. */
export const CLINIC_IMPORT_LIMITS = {
  clinicName: 100,
  ownerName: 255,
  email: 255,
  phone: 20,
  slug: 100,
  commercialRegistration: 100,
  legalName: 255,
  currency: 3,
} as const;

/**
 * What a row resolved to. Stable and machine-readable — the UI translates them.
 * `will_create` is the only status a commit acts on; `created` and `failed`
 * exist only in a commit result.
 */
export const CLINIC_IMPORT_ROW_STATUS = [
  'will_create',
  'invalid',
  'duplicate_in_file',
  'already_exists',
  'sales_rep_not_found',
  'created',
  'failed',
] as const;
export type ClinicImportRowStatus = (typeof CLINIC_IMPORT_ROW_STATUS)[number];

/** Which identifier of a row collides with an existing clinic or account. */
export const CLINIC_IMPORT_CONFLICT = [
  'slug',
  'owner_email',
  'clinic_email',
  'commercial_registration_number',
] as const;
export type ClinicImportConflict = (typeof CLINIC_IMPORT_CONFLICT)[number];

/** Most tenant ids one audit entry lists. */
export const CLINIC_IMPORT_AUDIT_IDS_MAX = CLINIC_IMPORT_MAX_ROWS;

/** Clinics written at once. Bounded so an import can never hold more than this many pool connections. */
export const CLINIC_IMPORT_CONCURRENCY = 4;

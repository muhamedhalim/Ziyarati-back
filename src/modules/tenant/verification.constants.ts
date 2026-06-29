/**
 * Canonical verification document catalogue — the BACKEND source of truth.
 *
 * The frontend mirrors this list, but the backend enforces it: a clinic cannot
 * submit for review (or be approved) unless every `required` type is present.
 * Keep `value` slugs in sync with the frontend `VERIFICATION_DOC_TYPES`.
 */
export interface VerificationDocTypeDef {
  value: string;
  label: string;
  required: boolean;
}

export const VERIFICATION_DOC_TYPES: readonly VerificationDocTypeDef[] = [
  { value: 'commercial_registration', label: 'Commercial Registration (CR)', required: true },
  { value: 'national_id', label: 'Owner National ID', required: true },
  { value: 'license', label: 'Ministry of Health License', required: true },
  { value: 'vat_certificate', label: 'VAT Certificate', required: false },
  { value: 'medical_liability_insurance', label: 'Medical Liability Insurance', required: false },
] as const;

export const REQUIRED_DOC_TYPES: readonly string[] = VERIFICATION_DOC_TYPES.filter(
  (d) => d.required,
).map((d) => d.value);

export function labelForDocType(value: string): string {
  return (
    VERIFICATION_DOC_TYPES.find((d) => d.value === value)?.label ?? value
  );
}

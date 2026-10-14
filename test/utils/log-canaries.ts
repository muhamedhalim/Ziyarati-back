/**
 * SYNTHETIC canary values for logging-privacy regression tests
 * (LOGGING-SECURITY-AUDIT 2026-10-14, LOGGING-PRIVACY-REMEDIATION). None
 * identifies a real person: names are invented tokens, numbers are made up and
 * the e-mail uses the reserved `.test` TLD. Each value is unique, so a hit in
 * captured output can be attributed to exactly one input.
 *
 * Lives under `test/` so it is never part of the production build.
 */
export const CANARY = {
  nameEn: 'Zqxcanary Patientname',
  nameAr: 'زكريا كناريون',
  guardian: 'Wqxcanary Guardianname',
  doctor: 'Vqxcanary Doctorname',
  clinic: 'Uqxcanary Dental Clinic',
  phoneAscii: '0599000111',
  phoneIntl: '+966599000112',
  phoneParen: '(059) 900-0113',
  phoneDots: '059.900.0114',
  phoneArabicIndic: '٠٥٩٩٠٠٠١١٥',
  phoneLocal7: '9000116',
  email: 'canary.patient@example.test',
  nationalId: '1099000117',
  egyptId: '29901011099118',
  diagnosis: 'CANARYDIAGNOSIS-hypertension',
  symptom: 'CANARYSYMPTOM-chestpain',
  medication: 'CANARYMEDICATION-metformin',
  clinicalNote: 'CANARYCLINICALNOTE-followup',
  history: 'CANARYHISTORY-asthma',
  address: 'CANARYADDRESS-street-5',
  appointmentReason: 'CANARYVISITREASON-pregnancy',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.CANARYsig123456',
  bearerOpaque: 'CANARYOPAQUEBEARER1234',
  cookieVal: 'CANARYCOOKIEVAL123',
  openaiKey: 'sk-proj-CANARYopenaiKEY1234567890',
  tapKey: 'sk_live_CANARYtapKEY12345',
  awsKey: 'AKIACANARYAWSKEY1234',
  signedSig: 'CANARYSIGNEDSIG123',
  dbParam: 'CANARYDBPARAM',
  otp: '482913',
  ipv4: '203.0.113.77',
} as const;

export type CanaryKey = keyof typeof CANARY;

function variants(value: string): string[] {
  const out = new Set<string>([value]);
  out.add(encodeURIComponent(value));
  out.add(JSON.stringify(value).slice(1, -1));
  out.add(
    value.replace(
      /[^\x00-\x7f]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    ),
  );
  // Digits only — catches a phone/ID re-serialized without its separators.
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length >= 7 && digits.length === value.replace(/[^0-9٠-٩]/g, '').length) {
    out.add(digits);
  }
  return [...out].filter((v) => v.length > 0);
}

/**
 * True if the canary (raw, URL-encoded, JSON-escaped, \\u-escaped or — for
 * digit canaries — digits-only) appears anywhere in `text`.
 *
 * Case-INSENSITIVE on purpose: the audit's harness reported one case "clean"
 * only because PostgreSQL lower-cased an expression-index key
 * (`lower(full_name)`), and a case-sensitive search missed the leaked value.
 */
export function leaked(text: string, value: string): boolean {
  const hay = text.toLowerCase();
  return variants(value).some((v) => hay.includes(v.toLowerCase()));
}

/** The canary keys found in `text`. */
export function leakedCanaries(
  text: string,
  keys: readonly CanaryKey[] = Object.keys(CANARY) as CanaryKey[],
): CanaryKey[] {
  return keys.filter((k) => leaked(text, CANARY[k]));
}

import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import {
  CANARY,
  leaked,
  leakedCanaries,
} from '../../../test/utils/log-canaries';
import { StructuredLogger } from './structured-logger';

/**
 * LOGGING-PRIVACY-REMEDIATION regressions for LSA-04 / LSA-05 / LSA-10 /
 * LSA-11, asserted on the FINAL serialized line. Synthetic canaries only.
 */
function capture() {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    role: 'api',
    env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' },
    destination: { write: (s: string) => void lines.push(s) },
  });
  return {
    logger,
    out: () => lines.join(''),
    records: () => lines.map((l) => JSON.parse(l) as Record<string, any>),
    lines,
  };
}

/** The 97 field names the audit's S1 matrix used (53 of them leaked before). */
const AUDIT_KEYS = [
  'phone',
  'phoneNumber',
  'phone_number',
  'patientPhone',
  'mobile',
  'mobileNumber',
  'whatsapp',
  'whatsappNumber',
  'wa_id',
  'msisdn',
  'to',
  'email',
  'emailAddress',
  'patientEmail',
  'name',
  'fullName',
  'full_name',
  'firstName',
  'lastName',
  'patientName',
  'customerName',
  'doctorName',
  'staffName',
  'guardianName',
  'parentName',
  'guardian',
  'notes',
  'note',
  'medicalNotes',
  'medical_notes',
  'clinicalNotes',
  'diagnosis',
  'diagnoses',
  'icd10',
  'symptoms',
  'symptom',
  'complaint',
  'chiefComplaint',
  'medication',
  'medications',
  'prescription',
  'allergies',
  'medicalHistory',
  'chronicDiseases',
  'nationalId',
  'national_id',
  'iqama',
  'iqamaNumber',
  'passportNumber',
  'idNumber',
  'dob',
  'dateOfBirth',
  'birthDate',
  'gender',
  'address',
  'insuranceNumber',
  'policyNumber',
  'otp',
  'code',
  'verificationCode',
  'pin',
  'message',
  'text',
  'content',
  'body',
  'payload',
  'data',
  'details',
  'description',
  'reason',
  'query',
  'search',
  'q',
  'url',
  'comment',
  'caption',
  'transcript',
  'subject',
  'title',
  'answer',
  'visitReason',
  'reply',
  'prompt',
  'recipientName',
  'guestName',
  'password',
  'token',
  'accessToken',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'sessionId',
  'signature',
  'cardNumber',
  'cvv',
  'iban',
];

const NON_SHAPE = [
  CANARY.nameEn,
  CANARY.nameAr,
  CANARY.guardian,
  CANARY.diagnosis,
  CANARY.clinicalNote,
  CANARY.appointmentReason,
  CANARY.address,
] as const;

describe('LSA-04 — structured fields are allow-listed', () => {
  /**
   * Accepted, documented residuals (docs/LOGGING-PRIVACY-REMEDIATION.md):
   *  - `message` IS the log message channel: shape-scrubbed only (names and
   *    clinical prose pass) — call sites must not put patient text in it;
   *  - `code` / `reason` keep a single machine token (error codes such as
   *    `131047`, enums such as `rate_limited`), so a token-shaped value with a
   *    digit (`CANARYADDRESS-street-5`) survives there. Free text does not.
   * Anything outside this list leaking is a regression.
   */
  const RESIDUAL = new Set([
    ...NON_SHAPE.map((v) => `message=${v}`),
    `code=${CANARY.address}`,
    `reason=${CANARY.address}`,
  ]);

  it('none of the 97 audit field names leaks a non-shape value (names, clinical text) beyond the documented residuals', () => {
    const leaking: string[] = [];
    for (const key of AUDIT_KEYS) {
      for (const value of NON_SHAPE) {
        const { logger, out } = capture();
        logger.warn({ event: 'test.key_matrix', message: 'x', [key]: value });
        if (leaked(out(), value)) leaking.push(`${key}=${value}`);
      }
    }
    expect(leaking.filter((l) => !RESIDUAL.has(l))).toEqual([]);
    // Before remediation 53 of these 97 keys leaked; now only the residuals.
    expect(new Set(leaking.map((l) => l.split('=')[0]))).toEqual(
      new Set(['message', 'code', 'reason']),
    );
  });

  it('nested neutral keys, arrays, JSON strings and user-chosen keys leak nothing', () => {
    const { logger, out } = capture();
    logger.warn({
      event: 'test.nested',
      message: 'nested',
      result: {
        data: {
          patient: {
            label: CANARY.nameEn,
            extra: [CANARY.diagnosis, CANARY.nameAr],
          },
        },
        provider_response: JSON.stringify({
          to: CANARY.phoneIntl,
          text: CANARY.clinicalNote,
        }),
      },
      answers: { [CANARY.symptom]: true, [CANARY.guardian]: 'yes' },
      items: [{ value: CANARY.medication }, { value: CANARY.history }],
      vitals: { mobile_raw: 966599000119, weight: 83.4 },
    });
    expect(leakedCanaries(out())).toEqual([]);
    expect(out()).not.toContain('966599000119');
  });

  it('a 6-digit OTP under a neutral key does not survive', () => {
    const { logger, out } = capture();
    logger.log({
      event: 'test.otp',
      message: 'x',
      value: CANARY.otp,
      extra_info: `otp ${CANARY.otp}`,
    });
    expect(out()).not.toContain(CANARY.otp);
  });

  it('keeps the operational diagnostics an engineer needs', () => {
    const { logger, records } = capture();
    logger.warn({
      event: 'whatsapp.message.failed',
      message: 'provider rejected the message',
      appointment_id: '0b9c4f7e-1d2a-4e3b-8c5d-6f7a8b9c0d1e',
      tenantId: '11111111-2222-4333-8444-555555555555',
      provider: 'meta_graph',
      error_code: '131047',
      status: 400,
      http_status: 400,
      error_type: 'NotFoundException',
      template_name: 'appointment_reminder_v2',
      attempt: 2,
      duration_ms: 1234,
      retryable: false,
      origin: 'uncaughtException',
      locale: 'ar',
      queue_keys: ['page', 'limit'],
      at: new Date('2026-10-14T10:00:00.000Z'),
      count: 12_345_678,
    });
    expect(records()[0]).toMatchObject({
      appointment_id: '0b9c4f7e-1d2a-4e3b-8c5d-6f7a8b9c0d1e',
      tenantId: '11111111-2222-4333-8444-555555555555',
      provider: 'meta_graph',
      error_code: '131047',
      status: 400,
      error_type: 'NotFoundException',
      template_name: 'appointment_reminder_v2',
      attempt: 2,
      duration_ms: 1234,
      retryable: false,
      origin: 'uncaughtException',
      locale: 'ar',
      queue_keys: ['page', 'limit'],
      at: '2026-10-14T10:00:00.000Z',
      count: 12_345_678,
    });
  });

  it('an Error inside a field keeps its type and a shape-scrubbed message', () => {
    const { logger, records } = capture();
    logger.error({
      event: 'test.err_field',
      message: 'x',
      cause_error: new TypeError(`bad input for ${CANARY.phoneAscii}`),
    });
    const r = records()[0];
    expect(r.cause_error.type).toBe('TypeError');
    expect(r.cause_error.message).toContain('bad input for');
    expect(JSON.stringify(r)).not.toContain(CANARY.phoneAscii);
  });
});

describe('LSA-05 — free text: shaped identifiers and credentials are scrubbed', () => {
  it.each([
    ['phoneParen', CANARY.phoneParen],
    ['phoneDots', CANARY.phoneDots],
    ['phoneLocal7', CANARY.phoneLocal7],
    ['phoneIntl url-encoded', encodeURIComponent(CANARY.phoneIntl)],
    ['phoneArabicIndic', CANARY.phoneArabicIndic],
    ['openaiKey', CANARY.openaiKey],
    ['tapKey', CANARY.tapKey],
    ['awsKey', CANARY.awsKey],
    ['egyptId', CANARY.egyptId],
    ['nationalId', CANARY.nationalId],
    ['email', CANARY.email],
    ['jwt', CANARY.jwt],
  ])('%s in a message / error message / stack', (_name, value) => {
    const { logger, out } = capture();
    const err = new Error(`provider said: ${value} rejected`);
    logger.error(`send failed for ${value}`, err.stack);
    logger.error({ event: 'test.err', message: `x ${value}`, error: err });
    expect(out()).not.toContain(value);
  });

  it('cookie header, OTP and public IPv4 in text', () => {
    const { logger, out } = capture();
    logger.warn(`upstream echoed Cookie: zt_at=${CANARY.cookieVal}; csrf=1`);
    logger.warn(`your verification code is ${CANARY.otp}`);
    logger.warn(`blocked request from ${CANARY.ipv4}`);
    expect(out()).not.toContain(CANARY.cookieVal);
    expect(out()).not.toContain(CANARY.otp);
    expect(out()).not.toContain(CANARY.ipv4);
    expect(out()).toContain('203.0.113.0');
  });

  it('PostgreSQL expression-index detail (nested parentheses, lower-cased value)', () => {
    const { logger, out } = capture();
    logger.error(
      `duplicate key value violates unique constraint "uq_x" — Key (lower(full_name::text))=(${CANARY.nameEn.toLowerCase()}) already exists.`,
    );
    expect(leakedCanaries(out(), ['nameEn'])).toEqual([]);
    expect(out()).toContain('already exists');
  });
});

describe('LSA-10 — caller fields cannot replace trusted context', () => {
  const ctx = new TenantContextService();

  it('context request/user/tenant ids win; a differing caller value is kept as data_*', async () => {
    const { logger, records } = capture();
    await ctx.run(async () => {
      ctx.setCorrelationId('req-real-3f2b8c1e');
      ctx.setPrincipal({
        id: 'user-real',
        tenantId: 'tenant-real',
        roles: [],
        permissions: [],
      });
      logger.warn({
        event: 'test.spoof',
        message: 'x',
        tenant_id: 'spoofed-tenant',
        user_id: 'spoofed-user',
        request_id: 'spoofed-request',
      });
    });
    const r = records()[0];
    expect(r).toMatchObject({
      tenant_id: 'tenant-real',
      user_id: 'user-real',
      request_id: 'req-real-3f2b8c1e',
    });
    expect(r.data_tenant_id).toBe('spoofed-tenant');
  });

  it('outside any context, an explicit id is still logged (filter / bootstrap callers)', () => {
    const { logger, records } = capture();
    logger.warn({
      event: 'test.no_ctx',
      message: 'x',
      request_id: 'req-explicit-1',
      tenant_id: 't1',
    });
    expect(records()[0]).toMatchObject({
      request_id: 'req-explicit-1',
      tenant_id: 't1',
    });
  });
});

describe('LSA-11 — bounded record size', () => {
  it('a huge record is capped, keeping event, message, error and identity', () => {
    const { logger, lines, records } = capture();
    const big = Array.from({ length: 2_000 }, (_, i) => ({
      item_id: `id-${i}`,
      status: 'ok',
    }));
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) many[`batch_${i}`] = big;
    logger.error({
      event: 'test.big',
      message: 'big one',
      ...many,
      error: new Error('boom'),
    });
    expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(32_768 + 512);
    expect(records()[0]).toMatchObject({
      event: 'test.big',
      message: 'big one',
      truncated: true,
    });
    expect(records()[0].error.type).toBe('Error');
    expect(records()[0].original_bytes).toBeGreaterThan(32_768);
  });

  it('arrays are capped at 50 elements', () => {
    const { logger, records } = capture();
    logger.log({
      event: 'test.arr',
      message: 'x',
      item_ids: Array.from({ length: 200 }, (_, i) => `id-${i}`),
    });
    expect(records()[0].item_ids).toHaveLength(51);
  });
});

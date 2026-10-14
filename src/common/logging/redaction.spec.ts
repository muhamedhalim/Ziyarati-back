import { StructuredLogger } from './structured-logger';

/**
 * Phase 5 — passes representative FAKE secrets and personal data through the
 * real logger (structured fields, nested objects, arrays, free text, errors)
 * and asserts that not one raw value reaches the output stream.
 *
 * What this does NOT prove (LOGGING.md §Redaction limits): a secret under an
 * unrecognised key name whose value has no recognisable shape (e.g. a short
 * random word in `{ foo: 'hunter2' }`) is not caught. Allow-listed fields and
 * "never serialize request/entity objects" are the primary defence; this
 * deny-list is the backstop.
 */
const SECRETS = {
  password: 'Pa55w0rd!fake',
  passwordConfirmation: 'Pa55w0rd!fake-confirm',
  access_token: 'at_fake_7f3a9c1e2b4d',
  refreshToken: 'rt_fake_9a8b7c6d5e4f',
  apiKey: 'zt_live_fakeKey_0123456789abcdef',
  client_secret: 'cs_fake_abcdef0123',
  webhookSecret: 'whsec_fake_112233',
  authorization: 'Bearer fakebearertoken12345',
  cookie: 'access_token=fakecookievalue123; csrf_token=abc',
  'set-cookie': 'refresh_token=fakesetcookie456; HttpOnly',
  cardNumber: '4111111111111111',
  cvv: '737',
  national_id: '1012345678',
  iqama: '2123456789',
  mfa_code: '482913',
  otp: '551177',
  recovery_codes: ['rc-fake-aaaa', 'rc-fake-bbbb'],
  resetToken: 'reset_fake_5566778899',
  session_id: 'sess_fake_a1b2c3',
  email: 'patient.fake@example.com',
  phone: '+966512345678',
  diagnosis: 'Type 2 diabetes (fake)',
  notes: 'Patient reports chest pain since Tuesday (fake)',
  symptoms: 'fake-symptom-dizziness',
  signature: 'sha256=fakesignature0011223344',
};

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fakeSignaturePart123';

function captureLogger() {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    role: 'api',
    env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' },
    destination: { write: (s: string) => void lines.push(s) },
  });
  return { logger, output: () => lines.join('') };
}

function rawValues(): string[] {
  return Object.values(SECRETS).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

describe('Log redaction (Phase 5)', () => {
  it('redacts every sensitive top-level field by name', () => {
    const { logger, output } = captureLogger();
    logger.log({
      event: 'test.redaction.flat',
      message: 'flat fields',
      ...SECRETS,
    });
    for (const value of rawValues()) expect(output()).not.toContain(value);
    expect(output()).toContain('[REDACTED]');
  });

  it('redacts nested objects and arrays, including naming variations', () => {
    const { logger, output } = captureLogger();
    logger.warn({
      event: 'test.redaction.nested',
      message: 'nested',
      request: {
        headers: {
          Authorization: SECRETS.authorization,
          'X-Api-Key': SECRETS.apiKey,
          Cookie: SECRETS.cookie,
        },
      },
      provider: {
        credentials: {
          clientSecret: SECRETS.client_secret,
          ACCESS_TOKEN: SECRETS.access_token,
        },
      },
      patients: [
        {
          fullName: 'Fake Patient Name',
          nationalId: SECRETS.national_id,
          medications: ['fake-metformin'],
        },
        { contact: { Email: SECRETS.email, PHONE: SECRETS.phone } },
      ],
      payment: {
        card: {
          card_number: SECRETS.cardNumber,
          CVV: SECRETS.cvv,
          cardholder_name: 'FAKE HOLDER',
        },
      },
      mfa: { totp: SECRETS.mfa_code, backup_codes: SECRETS.recovery_codes },
    });
    const out = output();
    for (const value of [
      SECRETS.authorization,
      SECRETS.apiKey,
      SECRETS.cookie,
      SECRETS.client_secret,
      SECRETS.access_token,
      'Fake Patient Name',
      SECRETS.national_id,
      'fake-metformin',
      SECRETS.email,
      SECRETS.phone,
      SECRETS.cardNumber,
      'FAKE HOLDER',
      SECRETS.mfa_code,
      ...SECRETS.recovery_codes,
    ]) {
      expect(out).not.toContain(value);
    }
  });

  it('scrubs identifiers and credentials embedded in free text (message, error, stack)', () => {
    const { logger, output } = captureLogger();
    const err = new Error(
      `Provider rejected ${SECRETS.email} / ${SECRETS.phone} with token ${JWT} ` +
        `at https://graph.example/v21.0/me?access_token=${SECRETS.access_token}&x=1`,
    );
    logger.error(
      `call failed: Authorization: ${SECRETS.authorization}; card ${SECRETS.cardNumber}; id ${SECRETS.national_id}`,
      err.stack,
    );
    logger.error({
      event: 'test.redaction.error',
      message: 'wrapped',
      error: err,
    });
    const out = output();
    for (const value of [
      SECRETS.email,
      SECRETS.phone,
      JWT,
      SECRETS.access_token,
      'fakebearertoken12345',
      SECRETS.cardNumber,
      SECRETS.national_id,
    ]) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[JWT]');
  });

  it('never serializes request-like or entity-like objects, only their class name', () => {
    const { logger, output } = captureLogger();
    class IncomingMessage {
      headers = { authorization: SECRETS.authorization };
      body = { password: SECRETS.password };
    }
    class Customer {
      national_id = SECRETS.national_id;
      notes = SECRETS.notes;
    }
    logger.log({
      event: 'test.redaction.objects',
      message: 'objects',
      req: new IncomingMessage(),
      customer: new Customer(),
    });
    const out = output();
    expect(out).toContain('[IncomingMessage]');
    expect(out).toContain('[Customer]');
    for (const value of [
      SECRETS.authorization,
      SECRETS.password,
      SECRETS.national_id,
      SECRETS.notes,
    ]) {
      expect(out).not.toContain(value);
    }
  });

  it('keeps the operational identifiers an engineer needs', () => {
    const { logger, output } = captureLogger();
    logger.log({
      event: 'test.redaction.keep',
      message: 'ids survive',
      request_id: 'b6f1d1a2-58b4-4b0e-9b7e-1f2a3b4c5d6e',
      job_id: '123456789012345',
      appointment_id: '0b9c4f7e-1d2a-4e3b-8c5d-6f7a8b9c0d1e',
      status: 503,
      duration_ms: 1234,
    });
    const out = output();
    expect(out).toContain('b6f1d1a2-58b4-4b0e-9b7e-1f2a3b4c5d6e');
    expect(out).toContain('"job_id":"123456789012345"');
    expect(out).toContain('0b9c4f7e-1d2a-4e3b-8c5d-6f7a8b9c0d1e');
    expect(out).toContain('"status":503');
  });
});

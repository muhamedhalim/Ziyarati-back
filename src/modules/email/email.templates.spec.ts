import {
  EMAIL_TEMPLATES,
  renderEmail,
  type EmailTemplateKey,
  type RenderContext,
} from './email.templates';

/**
 * T155 / LR-003 — Arabic email variants reuse the EXISTING `RenderContext.locale`
 * plumbing (already threaded from `EmailSendJob.locale` through
 * `EmailDeliveryService`); no second mechanism is introduced. Every template key
 * must render distinct, real Arabic content for `locale: 'ar'` — not silently
 * fall back to English — and the Arabic HTML must be RTL so it actually reads
 * correctly, not just contain translated words inside an LTR layout.
 */

const ALL_KEYS = Object.keys(EMAIL_TEMPLATES) as EmailTemplateKey[];

const enCtx: RenderContext = { appUrl: 'https://app.test', locale: 'en' };
const arCtx: RenderContext = { appUrl: 'https://app.test', locale: 'ar' };

const VARS_BY_KEY: Partial<Record<EmailTemplateKey, Record<string, unknown>>> =
  {
    password_reset: {
      name: 'Sara',
      resetUrl: 'https://app.test/reset?token=abc',
    },
    email_verification: {
      name: 'Sara',
      verifyUrl: 'https://app.test/verify?token=abc',
    },
    staff_invitation: {
      name: 'Sara',
      invitationUrl: 'https://app.test/invite?token=abc',
    },
    staff_credentials: {
      name: 'Sara',
      role: 'Receptionist',
      to: 'sara@clinic.com',
      temporaryPassword: 'Ab3xQ9zK2mNp',
      loginUrl: 'https://app.test/auth/login',
    },
  };

function varsFor(key: EmailTemplateKey): Record<string, unknown> {
  return VARS_BY_KEY[key] ?? { name: 'Sara' };
}

describe('EMAIL_TEMPLATES — Arabic variants (T155)', () => {
  it('every template key renders SOME output for both locales without throwing', () => {
    for (const key of ALL_KEYS) {
      expect(() => renderEmail(key, varsFor(key), enCtx)).not.toThrow();
      expect(() => renderEmail(key, varsFor(key), arCtx)).not.toThrow();
    }
  });

  it('every template key renders genuinely different subject/html text for ar vs en — not a silent English fallback', () => {
    for (const key of ALL_KEYS) {
      const en = renderEmail(key, varsFor(key), enCtx);
      const ar = renderEmail(key, varsFor(key), arCtx);
      expect([key, ar.subject]).not.toEqual([key, en.subject]);
      expect([key, ar.html]).not.toEqual([key, en.html]);
      expect([key, ar.text]).not.toEqual([key, en.text]);
    }
  });

  it('every template key renders actual Arabic-script characters in the ar variant', () => {
    const arabicRun = /[؀-ۿ]{2,}/;
    for (const key of ALL_KEYS) {
      const ar = renderEmail(key, varsFor(key), arCtx);
      expect([key, arabicRun.test(ar.subject)]).toEqual([key, true]);
      expect([key, arabicRun.test(ar.html)]).toEqual([key, true]);
    }
  });

  it('the ar variant HTML document is RTL; the en variant is LTR (whole-message direction, not just translated words)', () => {
    const en = renderEmail('welcome', { name: 'Sara' }, enCtx);
    const ar = renderEmail('welcome', { name: 'Sara' }, arCtx);
    expect(en.html).toMatch(/<html[^>]*\bdir=(["'])ltr\1/);
    expect(ar.html).toMatch(/<html[^>]*\bdir=(["'])rtl\1/);
  });

  it('interpolated user values remain HTML-escaped in the Arabic variant too (no injection regression)', () => {
    const rendered = renderEmail(
      'welcome',
      { name: '<script>alert(1)</script>', clinicName: 'Test' },
      arCtx,
    );
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
  });

  it('an unknown locale falls back to the configured default (English) rather than throwing or rendering blank', () => {
    const rendered = renderEmail(
      'welcome',
      { name: 'Sara' },
      { appUrl: 'https://app.test', locale: 'fr' },
    );
    expect(rendered.subject.length).toBeGreaterThan(0);
  });
});

describe('EMAIL_TEMPLATES — staff_credentials', () => {
  it('shows the recipient email, temporary password and a working login link', () => {
    const rendered = renderEmail(
      'staff_credentials',
      {
        name: 'Sara',
        role: 'Receptionist',
        to: 'sara@clinic.com',
        temporaryPassword: 'Ab3xQ9zK2mNp',
        loginUrl: 'https://app.test/auth/login',
      },
      enCtx,
    );
    expect(rendered.html).toContain('sara@clinic.com');
    expect(rendered.html).toContain('Ab3xQ9zK2mNp');
    expect(rendered.html).toContain('https://app.test/auth/login');
    expect(rendered.text).toContain('Ab3xQ9zK2mNp');
  });

  // StaffService omits `role` entirely for a synthesized custom role (its
  // display name embeds the recipient's own full name — see
  // StaffService.createWithNewUser) — the rendered copy must read cleanly
  // with no dangling "as" and no literal "undefined".
  it('renders cleanly with no role/clinicName supplied (the custom-role path)', () => {
    const rendered = renderEmail(
      'staff_credentials',
      {
        name: 'Sara',
        to: 'sara@clinic.com',
        temporaryPassword: 'Ab3xQ9zK2mNp',
        loginUrl: 'https://app.test/auth/login',
      },
      enCtx,
    );
    expect(rendered.html).not.toContain('undefined');
    expect(rendered.html).not.toMatch(/\bas\s*<\/p>|\bas\s*<\/h1>/);
    expect(rendered.text).not.toContain('undefined');
    expect(rendered.html).toContain('Ab3xQ9zK2mNp');
  });
});

/**
 * Phase 11 (US7, T132/FR-E009) — the marketing family (`campaign_marketing`)
 * must be provably SEPARATE from every transactional template: no
 * transactional key gains unsubscribe semantics, and rendering the marketing
 * template does not perturb any transactional key's output. FR-E009's
 * hard requirement (a marketing unsubscribe must never block a reminder or
 * receipt) starts here — if a transactional template ever grew an
 * unsubscribe link, an email client or a future refactor could plausibly wire
 * it to the same suppression path, which is exactly the regression this
 * pins against.
 */
describe('EMAIL_TEMPLATES — marketing vs transactional separation (T132)', () => {
  const TRANSACTIONAL_KEYS = ALL_KEYS.filter((k) => k !== 'campaign_marketing');

  it('no transactional template renders an "unsubscribe" footer (en or ar)', () => {
    for (const key of TRANSACTIONAL_KEYS) {
      const en = renderEmail(key, varsFor(key), enCtx);
      const ar = renderEmail(key, varsFor(key), arCtx);
      expect([key, /unsubscribe/i.test(en.html)]).toEqual([key, false]);
      expect([
        key,
        /إلغاء الاشتراك في الرسائل التسويقية/.test(ar.html),
      ]).toEqual([key, false]);
    }
  });

  it("rendering campaign_marketing does not change any transactional template's output (pure functions, no shared mutable state)", () => {
    const before = TRANSACTIONAL_KEYS.map((key) =>
      renderEmail(key, varsFor(key), enCtx),
    );
    renderEmail(
      'campaign_marketing',
      {
        subject: 'Sale',
        body: 'Big news',
        unsubscribeUrl: 'https://app.test/unsubscribe/tok',
      },
      enCtx,
    );
    const after = TRANSACTIONAL_KEYS.map((key) =>
      renderEmail(key, varsFor(key), enCtx),
    );
    expect(after).toEqual(before);
  });

  it('campaign_marketing carries an unsubscribe link when one is supplied, and escapes clinic-authored body content', () => {
    const rendered = renderEmail(
      'campaign_marketing',
      {
        name: 'Sara',
        subject: '20% off this month',
        body: 'Hi <script>alert(1)</script>\nSecond line',
        unsubscribeUrl: 'https://app.test/unsubscribe/tok',
      },
      enCtx,
    );
    expect(rendered.html).toContain('unsubscribe/tok');
    expect(/unsubscribe/i.test(rendered.html)).toBe(true);
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('Second line');
  });

  it('campaign_marketing renders with no unsubscribe link at all when none is supplied (never throws, never fabricates one)', () => {
    const rendered = renderEmail(
      'campaign_marketing',
      { name: 'Sara', subject: 'Hello', body: 'Just checking in' },
      enCtx,
    );
    expect(/unsubscribe/i.test(rendered.html)).toBe(false);
  });
});

describe('EMAIL_TEMPLATES — minimal appointment notices (residency plan P8)', () => {
  const appt = {
    name: 'Sara',
    service: 'Fertility consultation',
    doctor: 'Dr Omar',
    doctorName: 'Dr Omar',
    specialty: 'Oncology',
    reason: 'patient reported chest pain',
    dateTime: '2026-10-07 09:30',
    clinicName: 'Noor Clinic',
  };
  const detail = ['Fertility', 'Omar', 'Oncology', 'chest pain'];

  it.each([
    'appointment_confirmation',
    'appointment_reminder',
    'appointment_cancelled',
    'appointment_rescheduled',
  ] as const)('%s carries date and clinic but no care detail by default, in both languages', (key) => {
    for (const ctx of [enCtx, arCtx]) {
      const out = renderEmail(key, appt, ctx);
      const everything = `${out.subject}${out.html}${out.text}`;
      for (const word of detail) expect(everything).not.toContain(word);
    }
    const en = renderEmail(key, appt, enCtx);
    if (key !== 'appointment_rescheduled' && key !== 'appointment_cancelled') {
      expect(en.text).toContain('Noor Clinic');
    }
    expect(en.text).toContain('2026-10-07 09:30');
  });

  it('restores the detail only when the platform opts in', () => {
    const out = renderEmail('appointment_confirmation', appt, {
      ...enCtx,
      includeHealthDetail: true,
    });
    expect(out.text).toContain('Fertility consultation');
    const cancelled = renderEmail('appointment_cancelled', appt, {
      ...enCtx,
      includeHealthDetail: true,
    });
    expect(cancelled.text).toContain('chest pain');
  });

  it('does not mutate the caller’s variables', () => {
    const copy = JSON.stringify(appt);
    renderEmail('appointment_confirmation', appt, enCtx);
    expect(JSON.stringify(appt)).toBe(copy);
  });

  it('strips identifiers from caller-supplied notice text but leaves the sentence readable', () => {
    for (const key of ['patient_notification', 'doctor_notification', 'security_alert', 'generic']) {
      const out = renderEmail(
        key,
        { title: 'Update', message: 'Your ID 1012345678 and card 4111111111111111 changed.' },
        enCtx,
      );
      const everything = `${out.subject}${out.html}${out.text}`;
      expect(everything).not.toContain('1012345678');
      expect(everything).not.toContain('4111111111111111');
      expect(everything).toContain('changed.');
    }
  });

  it('does not touch templates that are not appointment or free-text notices', () => {
    const out = renderEmail('payment_failed', { name: 'Sara', amount: 'SAR 250', reason: 'card declined' }, enCtx);
    expect(out.text).toContain('card declined');
  });
});

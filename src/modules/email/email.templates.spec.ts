import { EMAIL_TEMPLATES, renderEmail, type EmailTemplateKey, type RenderContext } from './email.templates';

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

const VARS_BY_KEY: Partial<Record<EmailTemplateKey, Record<string, unknown>>> = {
  password_reset: { name: 'Sara', resetUrl: 'https://app.test/reset?token=abc' },
  email_verification: { name: 'Sara', verifyUrl: 'https://app.test/verify?token=abc' },
  staff_invitation: { name: 'Sara', invitationUrl: 'https://app.test/invite?token=abc' },
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
    const rendered = renderEmail('welcome', { name: 'Sara' }, { appUrl: 'https://app.test', locale: 'fr' });
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

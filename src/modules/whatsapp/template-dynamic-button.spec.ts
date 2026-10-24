import { validateTemplateAuthoring } from './template-authoring.validator';
import {
  isFillableDynamicUrl,
  missingVariables,
  unsupportedTemplateShape,
  urlButtonParameters,
} from './template-variables.util';
import { computeReadiness, unboundPlaceholders } from './template-readiness';
import { normalizeE164 } from './template-components.util';

const BODY = {
  type: 'BODY',
  text: 'مرحباً {{1}}، موعدك مؤكد في العيادة.',
  example: ['سارة'],
};
const withButton = (b: Record<string, unknown>): any => ({
  category: 'UTILITY',
  components: [BODY, { type: 'BUTTONS', buttons: [b] }],
});
const codes = (r: ReturnType<typeof validateTemplateAuthoring>) =>
  r.issues.map((i) => i.code);

describe('dynamic URL buttons — authoring validator', () => {
  it('accepts one {{1}} at the end of an https link with a complete sample', () => {
    const r = validateTemplateAuthoring(
      withButton({
        type: 'URL',
        text: 'Open',
        url: 'https://a.test/x/{{1}}',
        example: 'https://a.test/x/abc',
      }),
    );
    expect(r.valid).toBe(true);
  });

  it('requires a sample link — Meta rejects the template without one', () => {
    const r = validateTemplateAuthoring(
      withButton({ type: 'URL', text: 'Open', url: 'https://a.test/x/{{1}}' }),
    );
    expect(codes(r)).toContain('BUTTON_URL_EXAMPLE_REQUIRED');
    expect(r.valid).toBe(false);
  });

  it.each([
    ['a placeholder mid-link', 'https://a.test/{{1}}/x'],
    ['{{2}}', 'https://a.test/x/{{2}}'],
    ['two placeholders', 'https://a.test/{{1}}/{{1}}'],
    ['a placeholder in the host', 'https://{{1}}.test/x'],
  ])('refuses %s', (_l, url) => {
    const r = validateTemplateAuthoring(
      withButton({
        type: 'URL',
        text: 'Open',
        url,
        example: 'https://a.test/x/abc',
      }),
    );
    expect(codes(r)).toContain('BUTTON_URL_VARIABLE_POSITION');
  });

  it('allows only one link button with a variable', () => {
    const r = validateTemplateAuthoring(<any>{
      category: 'UTILITY',
      components: [
        BODY,
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'A',
              url: 'https://a.test/{{1}}',
              example: 'https://a.test/1',
            },
            {
              type: 'URL',
              text: 'B',
              url: 'https://b.test/{{1}}',
              example: 'https://b.test/1',
            },
          ],
        },
      ],
    });
    expect(codes(r)).toContain('BUTTON_URL_MULTIPLE_DYNAMIC');
  });

  it('now requires https (the message always said so; http used to slip through)', () => {
    const r = validateTemplateAuthoring(
      withButton({ type: 'URL', text: 'Open', url: 'http://a.test/x' }),
    );
    expect(codes(r)).toContain('BUTTON_URL_INVALID');
  });
});

describe('dynamic URL buttons — send-side shape and parameters', () => {
  const stored = (url: string) => ({
    components: [
      { type: 'BODY', text: 'Hi {{1}}, ok.' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Stop' },
          { type: 'URL', text: 'Open', url },
        ],
      },
    ],
  });

  it('a single trailing {{1}} is sendable; the parameter belongs to the button at its real index', () => {
    const c = stored('https://a.test/x/{{1}}');
    expect(unsupportedTemplateShape(c)).toBeUndefined();
    expect(urlButtonParameters(c)).toEqual([{ index: 1, key: 'button_1' }]);
    expect(isFillableDynamicUrl('https://a.test/x/{{1}}')).toBe(true);
  });

  it('a placeholder anywhere else is still refused — the platform could not fill it', () => {
    expect(unsupportedTemplateShape(stored('https://a.test/{{1}}/x'))).toMatch(
      /single \{\{1\}\}/,
    );
    expect(isFillableDynamicUrl('https://a.test/{{1}}/x')).toBe(false);
  });

  it('a static link has no button parameter', () => {
    expect(urlButtonParameters(stored('https://a.test/x'))).toEqual([]);
  });

  it('a send without the button value is "missing"; with it, complete', () => {
    const c = stored('https://a.test/x/{{1}}');
    expect(missingVariables(c, { '1': 'Sara' })).toEqual(['button_1']);
    expect(missingVariables(c, { '1': 'Sara', button_1: 'tok' })).toEqual([]);
    expect(missingVariables(c, { '1': 'Sara', button_1: '  ' })).toEqual([
      'button_1',
    ]);
  });
});

describe('normalizeE164', () => {
  it.each([
    ['+966 50 123 4567', '+966501234567'],
    ['00966501234567', '+966501234567'],
    ['966501234567', '+966501234567'],
  ])('%s → %s', (raw, want) => expect(normalizeE164(raw)).toBe(want));

  it.each([
    '0501234567',
    '12345',
    '+1234567890123456',
    '',
    null,
    undefined,
    'abc',
  ])('does not guess for %p', (raw) =>
    expect(normalizeE164(raw as any)).toBeUndefined(),
  );
});

describe('template readiness', () => {
  const ok = {
    status: 'approved',
    components: {
      components: [{ type: 'BODY', text: 'Hi {{1}}, hello there friend.' }],
    },
    variable_mapping: { '1': 'patient_first_name' } as Record<string, string>,
    waba_id: 'w1',
    needs_refresh: false,
  };
  const acct = {
    connection_status: 'CONNECTED',
    is_active: true,
    waba_id: 'w1',
  };
  const reasons = (t: any, a: any = acct) =>
    computeReadiness(t, a).reasons.map((r) => r.code);

  it('is ready only when approved, connected, matching, sendable and fully bound', () => {
    expect(computeReadiness(ok, acct)).toEqual({ ready: true, reasons: [] });
  });

  it.each([
    ['draft', 'NOT_SUBMITTED'],
    ['pending_review', 'IN_REVIEW'],
    ['rejected', 'REJECTED'],
    ['paused', 'PAUSED'],
    ['disabled', 'DISABLED'],
    ['SOMETHING_NEW_FROM_META', 'DISABLED'], // an unknown status is never "approved"
  ])('status %s blocks with %s', (status, code) => {
    const r = computeReadiness({ ...ok, status }, acct);
    expect(r.ready).toBe(false);
    expect(r.reasons).toContainEqual(
      expect.objectContaining({ code, blocking: true }),
    );
  });

  it('blocks on a missing, disconnected or inactive account and on a WABA mismatch', () => {
    expect(reasons(ok, null)).toContain('NO_ACCOUNT');
    expect(reasons(ok, { ...acct, connection_status: 'EXPIRED' })).toContain(
      'ACCOUNT_NOT_CONNECTED',
    );
    expect(reasons(ok, { ...acct, is_active: false })).toContain(
      'ACCOUNT_NOT_CONNECTED',
    );
    expect(reasons(ok, { ...acct, waba_id: 'other' })).toContain(
      'WABA_MISMATCH',
    );
  });

  it('blocks on unbound placeholders, including a link button and an empty typed constant', () => {
    expect(
      unboundPlaceholders({ components: ok.components, variable_mapping: {} }),
    ).toEqual(['1']);
    expect(
      unboundPlaceholders({
        components: ok.components,
        variable_mapping: { '1': 'fixed:' },
      }),
    ).toEqual(['1']);
    const withLink = {
      components: [
        { type: 'BODY', text: 'Hi {{1}}, hello there friend.' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', text: 'x', url: 'https://a.test/{{1}}' }],
        },
      ],
    };
    expect(
      unboundPlaceholders({
        components: { components: withLink.components },
        variable_mapping: { '1': 'patient_name' },
      }),
    ).toEqual(['button_0']);
  });

  it('blocks on a shape the platform cannot send', () => {
    const r = computeReadiness(
      {
        ...ok,
        components: {
          components: [
            { type: 'BODY', text: 'Hi' },
            { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] },
          ],
        },
      },
      acct,
    );
    expect(r.reasons.map((x) => x.code)).toContain('UNSUPPORTED_SHAPE');
  });

  it('a stale status is a WARNING, not a block — callers refresh before relying on it', () => {
    const r = computeReadiness({ ...ok, needs_refresh: true }, acct);
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([{ code: 'STATUS_STALE', blocking: false }]);
  });

  it('a draft is never "stale" — it has no Meta verdict to be out of date', () => {
    expect(
      reasons({ ...ok, status: 'draft', needs_refresh: true }),
    ).not.toContain('STATUS_STALE');
  });
});

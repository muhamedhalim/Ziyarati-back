import {
  validateTemplateAuthoring,
  TemplateAuthoringComponent,
  TemplateIssueCode,
} from './template-authoring.validator';

const body = (text: string, example?: string[]): TemplateAuthoringComponent => ({
  type: 'BODY',
  text,
  ...(example ? { example } : {}),
});

const codes = (r: ReturnType<typeof validateTemplateAuthoring>, sev?: 'error' | 'warning') =>
  r.issues.filter((i) => !sev || i.severity === sev).map((i) => i.code);

describe('validateTemplateAuthoring', () => {
  it('accepts a body with no variables', () => {
    const r = validateTemplateAuthoring({
      components: [body('Your appointment has been confirmed. We look forward to seeing you.')],
    });
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.variables.body).toEqual([]);
  });

  it('accepts a well-formed body with variables and one sample per variable', () => {
    const r = validateTemplateAuthoring({
      components: [
        body('Hello {{1}}, this is a reminder that your appointment is on {{2}}. Please arrive ten minutes early.', [
          'Sara',
          'Sunday 12 October at 5:00 PM',
        ]),
      ],
    });
    expect(r.valid).toBe(true);
    expect(codes(r)).toEqual([]);
    expect(r.variables.body).toEqual(['1', '2']);
  });

  it('flags excessive variable density as a WARNING, not an error (the reported Meta rejection)', () => {
    const r = validateTemplateAuthoring({
      components: [body('Hi {{1}} your visit {{2}} at {{3}} with {{4}} ok', ['a', 'b', 'c', 'd'])],
    });
    expect(codes(r, 'error')).toEqual([]);
    expect(codes(r, 'warning')).toContain('VARIABLE_DENSITY');
    expect(r.valid).toBe(true);
    const w = r.issues.find((i) => i.code === 'VARIABLE_DENSITY')!;
    expect(w.suggestion).toMatch(/more word/);
    expect(w.field).toBe('body');
  });

  it('does not warn when there is enough fixed text', () => {
    const r = validateTemplateAuthoring({
      components: [
        body(
          'Hello {{1}}, your appointment with the clinic is confirmed for {{2}}. Please bring your documents and arrive early.',
          ['Sara', 'Sunday'],
        ),
      ],
    });
    expect(codes(r)).not.toContain('VARIABLE_DENSITY');
  });

  it.each<[string, string[], TemplateIssueCode]>([
    ['Hello {{1}} and {{3}} in the message today', ['a', 'b'], 'VARIABLE_ORDER'],
    ['Hello {{2}} and {{1}} in the message today', ['a', 'b'], 'VARIABLE_ORDER'],
    ['{{1}} your appointment is confirmed for tomorrow morning', ['a'], 'VARIABLE_AT_START'],
    ['Your appointment is confirmed for tomorrow with {{1}}', ['a'], 'VARIABLE_AT_END'],
    ['Hello {{1}}{{2}} your appointment is confirmed for tomorrow', ['a', 'b'], 'VARIABLES_ADJACENT'],
    ['Hello {{1}} {{2}} your appointment is confirmed for tomorrow', ['a', 'b'], 'VARIABLES_ADJACENT'],
    ['Hello {{name}} your appointment is confirmed for tomorrow morning', [], 'VARIABLE_NOT_NUMERIC'],
    ['Hello {{1} your appointment is confirmed for tomorrow morning', ['a'], 'MALFORMED_BRACES'],
  ])('rejects %j', (text, examples, code) => {
    const r = validateTemplateAuthoring({ components: [body(text, examples)] });
    expect(r.valid).toBe(false);
    expect(codes(r, 'error')).toContain(code);
  });

  it('allows a placeholder followed by punctuation at the end', () => {
    const r = validateTemplateAuthoring({
      components: [body('Your appointment is confirmed for tomorrow with Dr. {{1}}.', ['Ahmed'])],
    });
    expect(codes(r, 'error')).not.toContain('VARIABLE_AT_END');
  });

  it('requires one non-empty sample per placeholder', () => {
    const missing = validateTemplateAuthoring({
      components: [body('Hello {{1}}, your appointment is confirmed for {{2}} at the clinic.', ['Sara'])],
    });
    expect(codes(missing, 'error')).toContain('EXAMPLE_COUNT');
    expect(missing.issues.find((i) => i.code === 'EXAMPLE_COUNT')!.field).toBe('examples');

    const blank = validateTemplateAuthoring({
      components: [body('Hello {{1}}, your appointment is confirmed for {{2}} at the clinic.', ['Sara', '  '])],
    });
    expect(codes(blank, 'error')).toContain('EXAMPLE_EMPTY');

    const braces = validateTemplateAuthoring({
      components: [body('Hello {{1}}, your appointment is confirmed at the clinic today.', ['{{1}}'])],
    });
    expect(codes(braces, 'error')).toContain('EXAMPLE_HAS_BRACES');
  });

  it('enforces Meta length limits', () => {
    const r = validateTemplateAuthoring({
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'h'.repeat(61) },
        body('b'.repeat(1025)),
        { type: 'FOOTER', text: 'f'.repeat(61) },
      ],
    });
    expect(codes(r, 'error')).toEqual(
      expect.arrayContaining(['HEADER_TOO_LONG', 'BODY_TOO_LONG', 'FOOTER_TOO_LONG']),
    );
  });

  it('refuses placeholders in the footer and (unsendable) header', () => {
    const r = validateTemplateAuthoring({
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}', example: ['Sara'] },
        body('Your appointment is confirmed for tomorrow morning at the clinic.'),
        { type: 'FOOTER', text: 'Ref {{1}}' },
      ],
    });
    expect(codes(r, 'error')).toEqual(
      expect.arrayContaining(['HEADER_VARIABLE_UNSUPPORTED', 'FOOTER_HAS_VARIABLE']),
    );
  });

  it('requires exactly one body', () => {
    expect(codes(validateTemplateAuthoring({ components: [] }), 'error')).toContain('BODY_REQUIRED');
    expect(
      codes(validateTemplateAuthoring({ components: [body('one text here ok'), body('two text here ok')] }), 'error'),
    ).toContain('BODY_DUPLICATE');
  });

  it('validates buttons', () => {
    const r = validateTemplateAuthoring({
      components: [
        body('Your appointment is confirmed for tomorrow morning at the clinic.'),
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'URL', text: 'Open', url: 'ftp://nope' },
            { type: 'QUICK_REPLY', text: 'Confirm' },
            { type: 'PHONE_NUMBER', text: 'Call' },
          ],
        },
      ],
    });
    expect(codes(r, 'error')).toEqual(
      expect.arrayContaining(['BUTTON_URL_INVALID', 'BUTTON_QUICK_REPLY_ORDER', 'BUTTON_PHONE_REQUIRED']),
    );
  });

  it('refuses the AUTHENTICATION category (no OTP components are built here)', () => {
    const r = validateTemplateAuthoring({
      category: 'AUTHENTICATION',
      components: [body('Your code is here for today.')],
    });
    expect(codes(r, 'error')).toContain('AUTHENTICATION_UNSUPPORTED');
  });

  it('counts Arabic fixed text as words', () => {
    const r = validateTemplateAuthoring({
      components: [
        body('مرحباً {{1}}، نذكّرك بأن موعدك في العيادة يوم {{2}} الساعة الخامسة مساءً، نرجو الحضور مبكراً.', [
          'سارة',
          'الأحد',
        ]),
      ],
    });
    expect(r.bodyStaticWords).toBeGreaterThan(8);
    expect(codes(r)).not.toContain('VARIABLE_DENSITY');
  });
});

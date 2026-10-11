/**
 * Pre-submission validation for WhatsApp template authoring.
 *
 * Meta reviews a template AFTER it is submitted and its rejection text is often
 * generic ("Invalid parameter … too many variables for its length"). Everything
 * here exists to catch, BEFORE the request leaves, the mistakes that are both
 * (a) documented by Meta and (b) cheap to detect, and to say where the problem
 * is and what to do about it.
 *
 * It is a pure function — no I/O, no Nest — so the create path, the dry-run
 * `validate` endpoint and the unit tests all share ONE definition of "valid".
 *
 * What this deliberately is NOT: a guarantee of approval. Meta's review also
 * covers policy, category fit and an undocumented variable-density rule. Issues
 * therefore carry a severity:
 *
 *   error    — a documented structural rule Meta would reject (or that this
 *              platform cannot send). Submission is refused.
 *   warning  — a heuristic that correlates with rejection but is not a
 *              published threshold. Submission is allowed; the author is told.
 *
 * Issues carry a stable machine `code` plus `params` so the UI can localise the
 * text (Arabic / English) — `message` / `suggestion` are English fallbacks, not
 * the display strings.
 *
 * Sources (verified 2026-10-11, Meta for Developers → WhatsApp → Templates →
 * Components & Review): body ≤ 1024 chars, header ≤ 60, footer ≤ 60, header
 * text supports one parameter, positional parameters are `{{1}}…{{n}}` numbered
 * sequentially with no gaps or out-of-order numbers, no special characters in a
 * parameter, a template cannot start or end with a parameter, sample values are
 * required whenever parameters are used, and "too many variable parameters
 * relative to the message length" is a rejection cause with NO published ratio.
 */

export type TemplateIssueSeverity = 'error' | 'warning';

export type TemplateIssueField =
  | 'name'
  | 'language'
  | 'category'
  | 'header'
  | 'body'
  | 'footer'
  | 'buttons'
  | 'examples'
  | 'general';

export interface TemplateIssue {
  /** Stable, UI-localisable identifier. */
  code: TemplateIssueCode;
  severity: TemplateIssueSeverity;
  field: TemplateIssueField;
  /** English fallback — the UI localises from `code` + `params`. */
  message: string;
  /** English fallback for the practical fix. */
  suggestion?: string;
  params?: Record<string, string | number>;
}

export type TemplateIssueCode =
  | 'BODY_REQUIRED'
  | 'BODY_DUPLICATE'
  | 'COMPONENT_DUPLICATE'
  | 'TEXT_REQUIRED'
  | 'BODY_TOO_LONG'
  | 'HEADER_TOO_LONG'
  | 'FOOTER_TOO_LONG'
  | 'FOOTER_HAS_VARIABLE'
  | 'HEADER_VARIABLE_UNSUPPORTED'
  | 'VARIABLE_NOT_NUMERIC'
  | 'MALFORMED_BRACES'
  | 'VARIABLE_ORDER'
  | 'VARIABLE_AT_START'
  | 'VARIABLE_AT_END'
  | 'VARIABLES_ADJACENT'
  | 'VARIABLE_DENSITY'
  | 'EXAMPLE_COUNT'
  | 'EXAMPLE_EMPTY'
  | 'EXAMPLE_HAS_BRACES'
  | 'BUTTONS_EMPTY'
  | 'BUTTON_TEXT_REQUIRED'
  | 'BUTTON_URL_REQUIRED'
  | 'BUTTON_PHONE_REQUIRED'
  | 'BUTTON_URL_INVALID'
  | 'BUTTON_QUICK_REPLY_ORDER'
  | 'AUTHENTICATION_UNSUPPORTED';

export interface TemplateAuthoringComponent {
  type: string;
  format?: string;
  text?: string;
  example?: string[];
  buttons?: Array<{
    type: string;
    text?: string;
    url?: string;
    phoneNumber?: string;
  }>;
}

export interface TemplateAuthoringInput {
  category?: string;
  components: TemplateAuthoringComponent[];
}

export interface TemplateValidationResult {
  /** True when there is no `error`-severity issue. Warnings never invalidate. */
  valid: boolean;
  issues: TemplateIssue[];
  /** The positional placeholders actually declared, in order (`['1','2']`). */
  variables: { header: string[]; body: string[] };
  /** Measured fixed-text word count of the body (placeholders excluded). */
  bodyStaticWords: number;
}

/** Meta's documented component limits. */
export const TEMPLATE_LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  buttonText: 25,
  buttonsTotal: 3,
} as const;

/**
 * Words of fixed text a body should carry per variable, plus one. NOT a Meta
 * number — Meta publishes no ratio. It is the widely-reported rule of thumb
 * (two variables ⇒ at least seven words), used only to raise a WARNING.
 */
export const DENSITY_WORDS_PER_VARIABLE = 3;

const TOKEN = /\{\{([^{}]*)\}\}/g;

interface ParsedText {
  /** Inner text of every `{{…}}` token, in order of appearance. */
  tokens: string[];
  /** Numeric tokens only, distinct, in first-seen order. */
  distinctNumeric: string[];
  hasNonNumeric: string[];
  hasStrayBraces: boolean;
}

function parseText(text: string): ParsedText {
  const tokens: string[] = [];
  for (const m of text.matchAll(TOKEN)) tokens.push(m[1].trim());

  const distinctNumeric: string[] = [];
  const nonNumeric: string[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      if (!distinctNumeric.includes(t)) distinctNumeric.push(t);
    } else if (!nonNumeric.includes(t)) {
      nonNumeric.push(t);
    }
  }
  const residue = text.replace(TOKEN, '');
  return {
    tokens,
    distinctNumeric,
    hasNonNumeric: nonNumeric,
    hasStrayBraces: /[{}]/.test(residue),
  };
}

function countStaticWords(text: string): number {
  const stripped = text.replace(TOKEN, ' ');
  return (stripped.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export function validateTemplateAuthoring(
  input: TemplateAuthoringInput,
): TemplateValidationResult {
  const issues: TemplateIssue[] = [];
  const push = (i: TemplateIssue) => issues.push(i);

  if (String(input.category ?? '').toUpperCase() === 'AUTHENTICATION') {
    push({
      code: 'AUTHENTICATION_UNSUPPORTED',
      severity: 'error',
      field: 'category',
      message:
        'Authentication templates need Meta’s one-time-password components, which this editor does not build.',
      suggestion: 'Choose Utility or Marketing.',
    });
  }

  const components = input.components ?? [];
  const bodies = components.filter((c) => c.type === 'BODY');
  if (bodies.length === 0) {
    push({
      code: 'BODY_REQUIRED',
      severity: 'error',
      field: 'body',
      message: 'A template needs a message body.',
      suggestion: 'Write the main message text.',
    });
  } else if (bodies.length > 1) {
    push({
      code: 'BODY_DUPLICATE',
      severity: 'error',
      field: 'body',
      message: 'A template can have only one body.',
    });
  }

  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.type) && c.type !== 'BODY') {
      push({
        code: 'COMPONENT_DUPLICATE',
        severity: 'error',
        field: 'general',
        message: `The ${c.type} component appears more than once.`,
        params: { component: c.type },
      });
    }
    seen.add(c.type);
  }

  const out: TemplateValidationResult = {
    valid: true,
    issues,
    variables: { header: [], body: [] },
    bodyStaticWords: 0,
  };

  for (const c of components) {
    if (c.type === 'BUTTONS') {
      validateButtons(c, push);
      continue;
    }
    if (c.type !== 'HEADER' && c.type !== 'BODY' && c.type !== 'FOOTER') continue;

    const field: TemplateIssueField =
      c.type === 'HEADER' ? 'header' : c.type === 'BODY' ? 'body' : 'footer';
    const text = (c.text ?? '').trim();
    if (!text) {
      push({
        code: 'TEXT_REQUIRED',
        severity: 'error',
        field,
        message: `The ${c.type.toLowerCase()} needs text.`,
        params: { component: c.type },
      });
      continue;
    }

    const limit = TEMPLATE_LIMITS[field];
    if (text.length > limit) {
      const code =
        c.type === 'BODY'
          ? 'BODY_TOO_LONG'
          : c.type === 'HEADER'
            ? 'HEADER_TOO_LONG'
            : 'FOOTER_TOO_LONG';
      push({
        code,
        severity: 'error',
        field,
        message: `The ${c.type.toLowerCase()} is ${text.length} characters; Meta allows at most ${limit}.`,
        suggestion: `Shorten it by ${text.length - limit} character(s).`,
        params: { length: text.length, limit },
      });
    }

    const parsed = parseText(text);

    if (parsed.hasStrayBraces) {
      push({
        code: 'MALFORMED_BRACES',
        severity: 'error',
        field,
        message:
          'A curly brace is not part of a complete {{number}} placeholder.',
        suggestion: 'Use {{1}}, {{2}}… with two braces on each side, or remove the stray brace.',
      });
    }
    for (const name of parsed.hasNonNumeric) {
      push({
        code: 'VARIABLE_NOT_NUMERIC',
        severity: 'error',
        field,
        message: `{{${name}}} is not a numbered placeholder.`,
        suggestion: 'Use numbered placeholders: {{1}}, {{2}}, {{3}}…',
        params: { token: name },
      });
    }

    if (c.type === 'FOOTER') {
      if (parsed.tokens.length > 0) {
        push({
          code: 'FOOTER_HAS_VARIABLE',
          severity: 'error',
          field,
          message: 'The footer cannot contain placeholders.',
          suggestion: 'Move the variable into the body.',
        });
      }
      continue;
    }

    if (c.type === 'HEADER') {
      if (parsed.tokens.length > 0) {
        // Meta allows one header parameter, but the platform's send path only
        // fills BODY parameters (variables are one flat map and `{{1}}` in the
        // header would collide with `{{1}}` in the body). Refuse at authoring
        // time rather than create a template every send of which Meta rejects.
        push({
          code: 'HEADER_VARIABLE_UNSUPPORTED',
          severity: 'error',
          field,
          message:
            'Placeholders in the header are not supported yet — messages could not be sent with them.',
          suggestion: 'Keep the header as plain text and put the variable in the body.',
        });
      }
      out.variables.header = parsed.distinctNumeric;
      continue;
    }

    // ── BODY ─────────────────────────────────────────────────────────────
    out.variables.body = parsed.distinctNumeric;
    const vars = parsed.distinctNumeric;

    // Sequence: first-seen order must be exactly 1, 2, 3 … n.
    const inOrder = vars.every((v, i) => Number(v) === i + 1);
    if (vars.length > 0 && !inOrder) {
      push({
        code: 'VARIABLE_ORDER',
        severity: 'error',
        field,
        message: `Placeholders must run 1, 2, 3… in order with no gaps (found ${vars
          .map((v) => `{{${v}}}`)
          .join(', ')}).`,
        suggestion: `Renumber them as ${vars.map((_, i) => `{{${i + 1}}}`).join(', ')} in the order they appear.`,
        params: { found: vars.join(','), expected: vars.map((_, i) => i + 1).join(',') },
      });
    }

    if (parsed.tokens.length > 0) {
      if (/^\{\{[^{}]*\}\}/.test(text)) {
        push({
          code: 'VARIABLE_AT_START',
          severity: 'error',
          field,
          message: 'The message cannot start with a placeholder.',
          suggestion: 'Add a greeting or a few words before the first placeholder, e.g. "Hello {{1}}".',
        });
      }
      if (/\{\{[^{}]*\}\}$/.test(text)) {
        push({
          code: 'VARIABLE_AT_END',
          severity: 'error',
          field,
          message: 'The message cannot end with a placeholder.',
          suggestion: 'Finish with a closing sentence or punctuation after the last placeholder.',
        });
      }
      if (/\}\}\s*\{\{/.test(text)) {
        push({
          code: 'VARIABLES_ADJACENT',
          severity: 'error',
          field,
          message: 'Two placeholders sit next to each other with only whitespace between them.',
          suggestion: 'Put words between them, or merge the two values into one placeholder.',
        });
      }
    }

    // Density — a heuristic, never an error (see the module docblock).
    const words = countStaticWords(text);
    out.bodyStaticWords = words;
    const needed = DENSITY_WORDS_PER_VARIABLE * vars.length + 1;
    if (vars.length > 0 && words < needed) {
      push({
        code: 'VARIABLE_DENSITY',
        severity: 'warning',
        field,
        message: `The body has ${vars.length} variable(s) but only ${words} word(s) of fixed text. Meta rejects templates with too many variables for their length.`,
        suggestion: `Add about ${needed - words} more word(s) of fixed text, or remove a variable. Meta publishes no exact ratio, so this is an estimate.`,
        params: { variables: vars.length, words, needed },
      });
    }

    // Samples.
    const examples = (c.example ?? []).map((e) => String(e ?? '').trim());
    if (vars.length > 0) {
      if (examples.length !== vars.length) {
        push({
          code: 'EXAMPLE_COUNT',
          severity: 'error',
          field: 'examples',
          message: `The body has ${vars.length} placeholder(s) but ${examples.length} sample value(s). Meta needs one sample per placeholder.`,
          suggestion: 'Provide a realistic sample value for every placeholder.',
          params: { variables: vars.length, examples: examples.length },
        });
      } else {
        examples.forEach((e, i) => {
          if (!e) {
            push({
              code: 'EXAMPLE_EMPTY',
              severity: 'error',
              field: 'examples',
              message: `The sample for {{${i + 1}}} is empty.`,
              suggestion: 'Enter a realistic example value.',
              params: { index: i + 1 },
            });
          } else if (/[{}]/.test(e)) {
            push({
              code: 'EXAMPLE_HAS_BRACES',
              severity: 'error',
              field: 'examples',
              message: `The sample for {{${i + 1}}} contains braces.`,
              suggestion: 'A sample is the actual value, e.g. "Sara", not another placeholder.',
              params: { index: i + 1 },
            });
          }
        });
      }
    }
  }

  out.valid = !issues.some((i) => i.severity === 'error');
  return out;
}

function validateButtons(
  c: TemplateAuthoringComponent,
  push: (i: TemplateIssue) => void,
): void {
  const buttons = c.buttons ?? [];
  if (buttons.length === 0) {
    push({
      code: 'BUTTONS_EMPTY',
      severity: 'error',
      field: 'buttons',
      message: 'The buttons section is empty.',
      suggestion: 'Add a button or remove the section.',
    });
    return;
  }
  let sawNonQuick = false;
  buttons.forEach((b, i) => {
    const text = (b.text ?? '').trim();
    if (!text || text.length > TEMPLATE_LIMITS.buttonText) {
      push({
        code: 'BUTTON_TEXT_REQUIRED',
        severity: 'error',
        field: 'buttons',
        message: `Button ${i + 1} needs a label of 1–${TEMPLATE_LIMITS.buttonText} characters.`,
        params: { index: i + 1, limit: TEMPLATE_LIMITS.buttonText },
      });
    }
    if (b.type === 'URL') {
      sawNonQuick = true;
      const url = (b.url ?? '').trim();
      if (!url) {
        push({
          code: 'BUTTON_URL_REQUIRED',
          severity: 'error',
          field: 'buttons',
          message: `Button ${i + 1} is a link button but has no URL.`,
          params: { index: i + 1 },
        });
      } else if (!/^https?:\/\//i.test(url)) {
        push({
          code: 'BUTTON_URL_INVALID',
          severity: 'error',
          field: 'buttons',
          message: `Button ${i + 1}'s URL must start with https://.`,
          params: { index: i + 1 },
        });
      }
    } else if (b.type === 'PHONE_NUMBER') {
      sawNonQuick = true;
      if (!(b.phoneNumber ?? '').trim()) {
        push({
          code: 'BUTTON_PHONE_REQUIRED',
          severity: 'error',
          field: 'buttons',
          message: `Button ${i + 1} is a call button but has no phone number.`,
          params: { index: i + 1 },
        });
      }
    } else if (b.type === 'QUICK_REPLY' && sawNonQuick) {
      push({
        code: 'BUTTON_QUICK_REPLY_ORDER',
        severity: 'error',
        field: 'buttons',
        message: 'Quick-reply buttons must come before link and call buttons.',
        params: { index: i + 1 },
      });
    }
  });
}

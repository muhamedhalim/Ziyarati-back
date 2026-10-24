import type { MetaTemplateComponentInput } from './meta/meta-graph.client';
import type { TemplateAuthoringComponent } from './template-authoring.validator';

/**
 * Stored/Meta-shaped components → the authoring shape the validator reads.
 *
 * A draft is stored in Meta's own vocabulary (`example.body_text`,
 * `phone_number`, a button `example` array) — the same shape a synced template
 * has, so the preview and the send-time shape checks never need to know a
 * template began life as a draft. The pre-submission validator, however, works
 * on the authoring shape (`example: string[]`, `phoneNumber`). This is the one
 * place the two are reconciled, so "what we validated" and "what we send" cannot
 * drift apart.
 */
export function metaToAuthoringComponents(
  components: unknown,
): TemplateAuthoringComponent[] {
  const list = (components as { components?: unknown } | undefined)?.components;
  if (!Array.isArray(list)) return [];

  return (list as MetaTemplateComponentInput[]).map((c) => {
    if (c.type === 'BUTTONS') {
      return {
        type: 'BUTTONS',
        buttons: (c.buttons ?? []).map((b) => ({
          type: b.type,
          text: b.text,
          url: b.url,
          phoneNumber: b.phone_number,
          example: b.example?.[0],
        })),
      };
    }
    const example =
      c.type === 'BODY'
        ? c.example?.body_text?.[0]
        : c.type === 'HEADER'
          ? c.example?.header_text
          : undefined;
    return {
      type: c.type,
      ...(c.format ? { format: c.format } : {}),
      text: c.text,
      ...(example ? { example } : {}),
    };
  });
}

/**
 * E.164: `+` and 8–15 digits. Returns `undefined` for anything that cannot be
 * trusted to be international — in particular a national-format number (`05…`),
 * whose country we cannot know: better a blank button the owner must fill than
 * a call button that dials the wrong number.
 */
export function normalizeE164(
  raw: string | null | undefined,
): string | undefined {
  const text = String(raw ?? '').trim();
  const international = text.startsWith('+') || text.startsWith('00');
  const digits = text.replace(/[^\d]/g, '').replace(/^00/, '');
  if (digits.length < 8 || digits.length > 15) return undefined;
  // No `+`/`00` prefix: accept only when it does not look national (a leading 0).
  if (!international && digits.startsWith('0')) return undefined;
  return `+${digits}`;
}

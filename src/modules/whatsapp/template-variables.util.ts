/**
 * FND-021 — WhatsApp template placeholder extraction and completeness check.
 *
 * `WhatsappTemplate.components` stores the provider's REAL shape, confirmed
 * live in `whatsapp-template-sync.service.spec.ts` ("wraps Meta's array into
 * the jsonb object column"): `{ components: [{ type: 'BODY', text: 'Hi
 * {{1}}, your appointment is on {{2}}.' }, ...] }`. Placeholders are
 * `{{<name>}}` tokens inside the BODY component's text — the only component
 * type that carries customer-facing variable substitutions in this codebase.
 */

interface TemplateComponent {
  type?: string;
  text?: string;
}

/** Every distinct `{{name}}` placeholder the template's BODY component declares, in first-seen order. */
export function extractRequiredVariables(components: unknown): string[] {
  if (!components || typeof components !== 'object') return [];
  const list = (components as { components?: unknown }).components;
  if (!Array.isArray(list)) return [];
  const body = (list as TemplateComponent[]).find((c) => c?.type === 'BODY');
  const text = body?.text;
  if (!text || typeof text !== 'string') return [];

  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

/** Names of required placeholders missing (absent, or present but empty/blank) from `variables`. */
export function missingVariables(
  components: unknown,
  variables: Record<string, unknown> | undefined,
): string[] {
  const required = extractRequiredVariables(components);
  if (required.length === 0) return [];
  const supplied = variables ?? {};
  return required.filter((name) => {
    const value = supplied[name];
    return value === undefined || value === null || String(value).trim() === '';
  });
}

/**
 * Renders the BODY component's text with every `{{name}}` placeholder
 * substituted from `variables`. Returns `undefined` if there is no BODY text
 * at all (caller decides how to treat that). Callers should check
 * `missingVariables` first — this performs no completeness check of its own.
 */
export function renderTemplateBody(
  components: unknown,
  variables: Record<string, unknown> | undefined,
): string | undefined {
  if (!components || typeof components !== 'object') return undefined;
  const list = (components as { components?: unknown }).components;
  if (!Array.isArray(list)) return undefined;
  const body = (list as { type?: string; text?: string }[]).find(
    (c) => c?.type === 'BODY',
  );
  const text = body?.text;
  if (!text || typeof text !== 'string') return undefined;

  return renderPlaceholders(text, variables);
}

/**
 * Substitutes every `{{name}}` in `text` from `variables`. A placeholder with
 * no supplied value is left EXACTLY as written (never blanked) — callers that
 * want a different fallback handle it themselves. Shared by the approved-
 * template path above and by plain-text workflow messages.
 */
export function renderPlaceholders(
  text: string,
  variables: Record<string, unknown> | undefined,
): string {
  const supplied = variables ?? {};
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name: string) => {
    const value = supplied[name];
    return value == null ? match : String(value);
  });
}

// ───────────────────────── Send-time parameter ordering ──────────────────────── //

interface RawComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; url?: string }>;
}

function componentList(components: unknown): RawComponent[] {
  if (!components || typeof components !== 'object') return [];
  const list = (components as { components?: unknown }).components;
  return Array.isArray(list) ? (list as RawComponent[]) : [];
}

/**
 * The BODY placeholders in the order Meta expects the parameters.
 *
 * Meta binds send-time parameters BY POSITION (positional templates) — the
 * n-th parameter fills `{{n}}`. The caller's `variables` object is a keyed map
 * whose iteration order is an accident of how it was built, so the order must
 * come from the template, never from the map. Numeric placeholders sort
 * ascending; named ones keep first-seen order (Meta binds those by name, so
 * order is cosmetic).
 */
export function orderedBodyParameters(components: unknown): string[] {
  const names = extractRequiredVariables({ components: componentList(components) });
  if (names.length > 0 && names.every((n) => /^\d+$/.test(n))) {
    return [...names].sort((a, b) => Number(a) - Number(b));
  }
  return names;
}

/** `NAMED` when the template declares named parameters, else `POSITIONAL`. */
export function templateParameterFormat(
  components: unknown,
): 'POSITIONAL' | 'NAMED' {
  const declared = (components as { parameter_format?: string } | undefined)?.parameter_format;
  if (typeof declared === 'string' && declared.toUpperCase() === 'NAMED') return 'NAMED';
  const names = extractRequiredVariables({ components: componentList(components) });
  return names.some((n) => !/^\d+$/.test(n)) ? 'NAMED' : 'POSITIONAL';
}

/**
 * Why this platform cannot SEND a template, or `undefined` when it can.
 *
 * The send path fills BODY parameters only. A template that also needs a
 * header parameter / media header / button parameter would be accepted by our
 * checks and refused by Meta with an opaque "parameter count mismatch" — so it
 * is refused here, up front, with a reason a clinic can act on.
 */
export function unsupportedTemplateShape(components: unknown): string | undefined {
  for (const c of componentList(components)) {
    const type = String(c.type ?? '').toUpperCase();
    if (type === 'HEADER') {
      const format = String(c.format ?? 'TEXT').toUpperCase();
      if (format !== 'TEXT') {
        return `has a ${format.toLowerCase()} header, which needs a media attachment at send time`;
      }
      if (/\{\{[^{}]*\}\}/.test(c.text ?? '')) {
        return 'has a placeholder in its header, which this platform cannot fill';
      }
    } else if (type === 'BUTTONS') {
      for (const b of c.buttons ?? []) {
        const bt = String(b.type ?? '').toUpperCase();
        if (bt === 'URL') {
          if (/\{\{[^{}]*\}\}/.test(b.url ?? '')) {
            return 'has a link button with a placeholder, which this platform cannot fill';
          }
        } else if (bt !== 'QUICK_REPLY' && bt !== 'PHONE_NUMBER') {
          return `has a ${bt.toLowerCase().replace(/_/g, ' ')} button, which needs send-time parameters this platform does not supply`;
        }
      }
    } else if (type !== 'BODY' && type !== 'FOOTER') {
      return `has a ${type.toLowerCase().replace(/_/g, ' ')} component, which this platform cannot send`;
    }
  }
  return undefined;
}

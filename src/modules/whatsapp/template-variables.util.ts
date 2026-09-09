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

  const supplied = variables ?? {};
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name: string) => {
    const value = supplied[name];
    return value == null ? match : String(value);
  });
}

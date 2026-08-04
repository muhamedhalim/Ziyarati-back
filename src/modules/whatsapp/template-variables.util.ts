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

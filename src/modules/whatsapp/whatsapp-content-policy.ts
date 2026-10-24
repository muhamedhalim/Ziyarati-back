import {
  containsClinicalTerm,
  findProhibitedIdentifiers,
  type ProhibitedCategory,
} from '../../common/utils/prohibited-content.util';
import { renderTemplateBody } from './template-variables.util';
import { WHATSAPP_BUTTON_PARAM_PREFIX } from './whatsapp.constants';
import type { WhatsappSessionPayload } from './providers/whatsapp-message.provider.interface';

/**
 * Outbound WhatsApp content policy (residency plan P5).
 *
 * The send seams (`WhatsappExecutionService.sendTemplateMessage` for templates,
 * `WhatsappMessagingService.sendSession` for free-form replies) ask this module
 * whether the content may leave. A violation REFUSES the send and reports the
 * CATEGORY and, for templates, the variable NAME — never the matched value, so
 * the refusal itself cannot leak what it blocked into a log, a notification-log
 * row or an HTTP response.
 *
 * Three checks, each with a different scope (see `prohibited-content.util.ts`
 * for why):
 *   1. every template VARIABLE value: identifiers + clinical terms;
 *   2. the RENDERED template body (the tenant's text with the variables filled
 *      in): identifiers only — the body is tenant-authored and Meta-approved, so
 *      a word list is not applied to it, but a national ID is never acceptable;
 *   3. a SESSION message's text, header, footer, buttons and list rows:
 *      identifiers only — a staff or AI reply may legitimately discuss care in
 *      general terms.
 */

export type ContentPolicyMode = 'enforce' | 'monitor' | 'off';

export interface ContentViolation {
  category: ProhibitedCategory;
  /** The template variable the content came from. Absent for body / session text. */
  variable?: string;
  /** Where the content was found. */
  scope: 'variable' | 'rendered_body' | 'session';
}

export function resolveContentPolicyMode(raw: unknown): ContentPolicyMode {
  const v = String(raw ?? 'enforce').toLowerCase();
  return v === 'monitor' || v === 'off' ? v : 'enforce';
}

export function assessTemplateContent(
  components: unknown,
  variables: Record<string, unknown> | undefined,
): ContentViolation[] {
  const violations: ContentViolation[] = [];

  for (const [name, raw] of Object.entries(variables ?? {})) {
    if (raw === null || raw === undefined) continue;
    // A dynamic-button value is the opaque secret WE issued, not clinic or
    // patient text: a random token can contain a long digit run that the
    // identifier detector would mistake for a national ID and block the send.
    if (name.startsWith(WHATSAPP_BUTTON_PARAM_PREFIX)) continue;
    const value = typeof raw === 'string' ? raw : String(raw);
    for (const category of findProhibitedIdentifiers(value)) {
      violations.push({ category, variable: name, scope: 'variable' });
    }
    if (containsClinicalTerm(value)) {
      violations.push({
        category: 'clinical_term',
        variable: name,
        scope: 'variable',
      });
    }
  }

  const rendered = renderTemplateBody(components, variables);
  if (rendered) {
    for (const category of findProhibitedIdentifiers(rendered)) {
      // A variable already reported the same category — do not double-count.
      if (!violations.some((v) => v.category === category)) {
        violations.push({ category, scope: 'rendered_body' });
      }
    }
  }
  return violations;
}

/** Every piece of text a session message puts in front of the recipient. */
function sessionTexts(payload: WhatsappSessionPayload): string[] {
  const i = payload.interactive;
  return [
    payload.text,
    i?.header,
    i?.footer,
    i?.list?.buttonText,
    ...(i?.buttons ?? []).map((b) => b.title),
    ...(i?.list?.sections ?? []).flatMap((s) => [
      s.title,
      ...s.rows.flatMap((r) => [r.title, r.description]),
    ]),
  ].filter((t): t is string => typeof t === 'string' && t.length > 0);
}

export function assessSessionContent(
  payload: WhatsappSessionPayload,
): ContentViolation[] {
  const found = new Set<ProhibitedCategory>();
  for (const text of sessionTexts(payload)) {
    for (const category of findProhibitedIdentifiers(text)) found.add(category);
  }
  return [...found].map((category) => ({
    category,
    scope: 'session' as const,
  }));
}

/** A reason that names categories and variable names only — safe to store and log. */
export function describeViolations(violations: ContentViolation[]): string {
  return violations
    .map((v) =>
      v.variable
        ? `${v.category} in "${v.variable}"`
        : `${v.category} in ${v.scope}`,
    )
    .join('; ');
}

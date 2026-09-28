/**
 * Backend safety net for Live Agent Handover's second trigger: the assistant
 * telling a patient that a person from the clinic will contact them, WITHOUT
 * calling `request_human_handover` (see `AI_TOOL.REQUEST_HUMAN_HANDOVER` in
 * `ai-tool-dispatch.service.ts`). The prompts already tell the model to call
 * the tool instead of promising this itself (`default-system-prompt.ts`:
 * "call request_human_handover, and never promise it yourself"), but a prompt
 * is not a guarantee — a model can still write the sentence without making
 * the call. `AiOrchestratorService` runs this over the assistant's FINAL
 * reply on every turn (`maybeEscalateOnPromisedContact`), so the clinic gets
 * notified either way, through the SAME `HandoverRequestService` path the
 * tool itself uses — no second notification flow.
 *
 * Deliberately CONSERVATIVE, not a generic "helpfulness" detector. It must
 * NOT match ordinary helpful phrasing like "we will help you" or "we can book
 * that for you" — only an explicit promise that a PERSON will CONTACT the
 * patient outside of this chat (call/reach out/get back to/follow up/be in
 * touch). English is matched with subject — future tense — contact verb —
 * "you", in that order, so "you can contact the clinic" does NOT match: the
 * direction is reversed. Arabic has no reliable ASCII-style word boundary in
 * JS regex, so it is matched as plain literal phrases instead of a pattern.
 *
 * A false positive costs one extra handover a human clears in seconds; a
 * false negative is a promise nobody keeps — so when genuinely ambiguous this
 * leans toward not matching, per the narrow verb list above, rather than
 * toward catching everything.
 */

const CONTACT_VERBS =
  '(?:contact|call|reach\\s+out(?:\\s+to)?|get\\s+back\\s+to|follow\\s+up\\s+with|be\\s+in\\s+touch\\s+with)';

const ENGLISH_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:the\\s+)?(?:clinic|team|staff|office|practice|receptionist|doctor|nurse|someone|a\\s+(?:member|representative|specialist|staff\\s+member|team\\s+member))\\b[\\s\\S]{0,60}\\b(?:will|shall|would|is\\s+going\\s+to)\\b[\\s\\S]{0,60}\\b${CONTACT_VERBS}\\b[\\s\\S]{0,30}\\byou\\b`,
    'i',
  ),
  new RegExp(
    `\\bwe(?:'ll|\\s+will|\\s+shall)\\b[\\s\\S]{0,50}\\b${CONTACT_VERBS}\\b[\\s\\S]{0,30}\\byou\\b`,
    'i',
  ),
];

/** Literal phrases: "will contact/call you", "we will contact/call you", "will follow up", "will call back". */
const ARABIC_PHRASES: readonly string[] = [
  'سيتواصل معك',
  'سيتواصل معكم',
  'سنتواصل معك',
  'سنتواصل معكم',
  'سيتصل بك',
  'سيتصل بكم',
  'سنتصل بك',
  'سنتصل بكم',
  'سيتم التواصل معك',
  'سيتم التواصل معكم',
  'سيقوم فريق العيادة بالتواصل',
  'سيتابع معك فريق العيادة',
  'سيعاود الاتصال بك',
  'سنعاود الاتصال بك',
  'سيرد عليك فريق العيادة',
];

/** True when `text` tells the reader that a clinic person will contact THEM. */
export function promisesHumanContact(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  if (ENGLISH_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return ARABIC_PHRASES.some((phrase) => trimmed.includes(phrase));
}

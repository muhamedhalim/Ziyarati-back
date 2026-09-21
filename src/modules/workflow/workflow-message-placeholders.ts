import { renderPlaceholders } from '../whatsapp/template-variables.util';
import { WORKFLOW_MESSAGE_PLACEHOLDER } from './workflow.constants';
import type { WorkflowPlaceholderValues } from './workflow-recipient.resolver';

const KNOWN = Object.values(WORKFLOW_MESSAGE_PLACEHOLDER).join('|');
const KNOWN_PLACEHOLDER = new RegExp(`\\{\\{\\s*(?:${KNOWN})\\s*\\}\\}`);

/** True when `text` contains a placeholder this engine resolves itself. */
export function hasWorkflowPlaceholder(text: string): boolean {
  return KNOWN_PLACEHOLDER.test(text);
}

/**
 * Renders a plain-text workflow message. Only the two known placeholders are
 * touched — any other `{{...}}` is left exactly as authored, same as
 * `renderPlaceholders` everywhere else.
 *
 * A KNOWN placeholder with no value (a patient with no recorded name) is
 * removed rather than sent literally, and the punctuation/spacing it leaves
 * behind is tidied — "Happy birthday, {{customerName}}!" degrades to "Happy
 * birthday!" instead of "Happy birthday, !". Text is only re-spaced when a
 * value was actually missing, so an authored message is never altered
 * otherwise.
 */
export function renderWorkflowMessage(
  text: string,
  values: WorkflowPlaceholderValues,
): string {
  const customerName = values.customerName ?? '';
  const clinicName = values.clinicName ?? '';
  const rendered = renderPlaceholders(text, {
    [WORKFLOW_MESSAGE_PLACEHOLDER.CUSTOMER_NAME]: customerName,
    [WORKFLOW_MESSAGE_PLACEHOLDER.CLINIC_NAME]: clinicName,
  });
  if (customerName && clinicName) return rendered;
  return rendered
    .replace(/[ \t]*[,،][ \t]*(?=[!.?؟])/g, '')
    .replace(/[ \t]+(?=[,،!.?؟])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

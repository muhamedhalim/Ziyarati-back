/**
 * Context-capture formatting helpers for Feature 011 (T016).
 *
 * `ScriptedAiProvider` (scripted-ai-provider.ts) already captures the exact
 * assembled `AiCompletionRequest.messages` array at the provider boundary —
 * that IS the capture mechanism (plan.md §W8 Method: "context capture via stub
 * provider"). This module only formats those captures into the verbatim,
 * evidence-grade shape the audit's Markdown deliverables require: human-
 * readable, redaction-aware, and stable enough to paste directly into
 * `evidence/*.md` without further editing.
 */
import { AiChatMessage, AiCompletionRequest } from '../../../src/modules/ai/providers/ai-provider.interface';
import { scanText, SecretHit } from './secret-scan';

export interface CapturedMessageSummary {
  index: number;
  role: AiChatMessage['role'];
  /** Full content for system/user/tool blocks; assistant tool-call turns show `null` per the real shape. */
  content: string | null;
  toolCallNames?: string[];
  toolCallId?: string;
  /** True when the content contains a `<knowledge>` or `<memory>` delimiter (defense-in-depth wrapper — see W7). */
  delimited: 'knowledge' | 'memory' | null;
}

/** Reduce one captured request's message array to the fields evidence files need — role, delimiter wrapper, and tool-call shape, without re-deriving anything the real interface doesn't already expose. */
export function summarizeMessages(messages: readonly AiChatMessage[]): CapturedMessageSummary[] {
  return messages.map((m, index) => ({
    index,
    role: m.role,
    content: m.content,
    toolCallNames: m.tool_calls?.map((tc) => tc.name),
    toolCallId: m.tool_call_id,
    delimited: m.content?.includes('<knowledge>')
      ? 'knowledge'
      : m.content?.includes('<memory>')
        ? 'memory'
        : null,
  }));
}

/** Render one captured request as a Markdown-ready block for direct inclusion in an `evidence/*.md` file, with any detected secret redacted (never pasted verbatim into evidence — see secret-scan.ts). */
export function renderCapturedRequestMarkdown(request: AiCompletionRequest, label = 'captured request'): string {
  const lines: string[] = [`\`\`\`text`, `# ${label} — model=${request.model ?? '(default)'} tenant=${request.tenantId}`];
  summarizeMessages(request.messages).forEach((m) => {
    const redacted = m.content !== null ? redactForEvidence(m.content) : null;
    const toolPart = m.toolCallNames?.length ? ` tool_calls=[${m.toolCallNames.join(', ')}]` : '';
    const delimPart = m.delimited ? ` [${m.delimited}-delimited]` : '';
    lines.push(`[${m.index}] role=${m.role}${toolPart}${delimPart}: ${redacted === null ? '(null)' : JSON.stringify(redacted)}`);
  });
  if (request.tools?.length) {
    lines.push(`tools advertised: [${request.tools.map((t) => t.name).join(', ')}]`);
  }
  lines.push('```');
  return lines.join('\n');
}

/** Replace any detected secret substring with `<REDACTED:pattern>` so evidence files never contain a live-looking credential even transiently. Field names / structure stay intact — only the matched span is masked. */
export function redactForEvidence(text: string): string {
  const hits = scanText(text);
  let out = text;
  for (const hit of hits) {
    out = out.split(hit.matchedText).join(`<REDACTED:${hit.pattern}>`);
  }
  return out;
}

/** Convenience: scan a captured request's full message array and return every secret hit found, tagged with the message index it came from — the T016 self-test and T120/T121 rely on this. */
export function scanCapturedRequest(request: AiCompletionRequest): (SecretHit & { messageIndex: number })[] {
  const hits: (SecretHit & { messageIndex: number })[] = [];
  request.messages.forEach((m, index) => {
    if (m.content) {
      for (const hit of scanText(m.content)) hits.push({ ...hit, messageIndex: index });
    }
  });
  return hits;
}

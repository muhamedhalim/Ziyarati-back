import type { AiBatchLineRequest } from '../providers/ai-batch-provider.interface';
import { scrubForEmbedding } from './ai-minimizer';

/**
 * Minimisation for Batch API input files (residency plan P2 / F10).
 *
 * A batch input file is uploaded to the provider and RETAINED there until it is
 * deleted, so it is the one outbound path where "send it and forget it" is not
 * true. This runs at the provider's single upload seam, so a producer cannot
 * bypass it.
 *
 *  - `/v1/embeddings`   left as written. The only producer today is knowledge
 *    ingestion, i.e. the clinic's own content, which the synchronous embedding
 *    path also embeds as written (KNOWLEDGE kind). Query and memory text never
 *    goes through the batch API.
 *  - `/v1/chat/completions`  every text part of every message gets the
 *    irreversible identifier scrub (phones, e-mails, IDs, cards). A batch has no
 *    live session to re-hydrate tokens into, so a reversible token map is not
 *    possible here.
 *  - any other endpoint is refused: nothing this system uses can produce one, and
 *    an unreviewed payload shape is not sent.
 *
 * Names cannot be detected without a structured source, so free-text names in a
 * chat batch are NOT removed. That is why no producer for the chat endpoint
 * exists and why this is a guard, not a licence to add one.
 */

export class BatchEndpointNotAllowedError extends Error {
  constructor(url: string) {
    super(`Batch endpoint "${url}" is not allowed`);
    this.name = 'BatchEndpointNotAllowedError';
  }
}

interface ChatPart {
  type?: unknown;
  text?: unknown;
  [k: string]: unknown;
}

function scrubContent(content: unknown): unknown {
  if (typeof content === 'string') return scrubForEmbedding(content);
  if (Array.isArray(content)) {
    return content.map((p: ChatPart | string) => {
      if (typeof p === 'string') return scrubForEmbedding(p);
      if (p && typeof p === 'object' && typeof p.text === 'string') {
        return { ...p, text: scrubForEmbedding(p.text) };
      }
      return p;
    });
  }
  return content;
}

function scrubChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  return {
    ...body,
    messages: messages.map((m: unknown) =>
      m && typeof m === 'object'
        ? {
            ...(m as Record<string, unknown>),
            content: scrubContent((m as Record<string, unknown>).content),
          }
        : m,
    ),
  };
}

/** Pure: returns new request objects; the input is not mutated. */
export function minimizeBatchRequests(
  requests: AiBatchLineRequest[],
  enabled = true,
): AiBatchLineRequest[] {
  return requests.map((r) => {
    if (r.url !== '/v1/embeddings' && r.url !== '/v1/chat/completions') {
      throw new BatchEndpointNotAllowedError(r.url);
    }
    if (!enabled || r.url === '/v1/embeddings') return r;
    return { ...r, body: scrubChatBody(r.body) };
  });
}

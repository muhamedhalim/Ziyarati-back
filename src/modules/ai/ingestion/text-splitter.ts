/**
 * Token-aware-ish text chunker for KB ingestion. Uses a word-count heuristic
 * (~0.75 words/token) with overlap to preserve context across chunk boundaries.
 * Good enough for retrieval; swap for a real tokenizer (tiktoken) if exactness
 * is needed.
 */
export interface SplitOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

export function splitIntoChunks(text: string, opts: SplitOptions = {}): string[] {
  const maxTokens = opts.maxTokens ?? 500;
  const overlapTokens = opts.overlapTokens ?? 60;

  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const wordsPerChunk = Math.max(1, Math.round(maxTokens * 0.75));
  const overlapWords = Math.max(0, Math.round(overlapTokens * 0.75));
  const step = Math.max(1, wordsPerChunk - overlapWords);

  const words = clean.split(/\s+/);
  if (words.length <= wordsPerChunk) return [clean];

  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    const chunk = words.slice(i, i + wordsPerChunk).join(' ').trim();
    if (chunk) chunks.push(chunk);
    if (i + wordsPerChunk >= words.length) break;
  }
  return chunks;
}

/**
 * Helpers for talking to pgvector via raw SQL. We pass embeddings as the pgvector
 * text literal `[v1,v2,...]` and cast with `$n::vector` in queries — this avoids a
 * hard dependency on a pgvector driver type and keeps the vector concern isolated
 * to the RAG + ingestion layers.
 */

/** Serialize a number[] embedding to the pgvector input literal. */
export function toSqlVector(values: number[]): string {
  // Guard against NaN/Infinity which pgvector rejects.
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

/** The sidecar table that stores KB-chunk embeddings (1:1 with ai_knowledge_bases). */
export const AI_KB_EMBEDDINGS_TABLE = 'ai_kb_embeddings';

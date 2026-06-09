import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AiKnowledgeBase } from '../../entities/AI Agent/AiKnowledgeBase';

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  sourceType?: string;
  sourceId?: string;
}

/**
 * Retrieval-Augmented Generation retriever.
 *
 * The schema has no active vector column, so retrieval is a KEYWORD abstraction:
 * it matches knowledge-base chunks for the agent against the query terms and
 * assigns a naive relevance score. The interface (`retrieve` → ranked chunks,
 * `assembleContext`) is what the execution layer depends on — swapping in a
 * vector store later requires no change to AiExecutionService.
 *
 * Tenant isolation: retrieval is always scoped to `tenant: { id }` and the
 * agent's chunks.
 */
@Injectable()
export class AiRagService {
  constructor(
    @InjectRepository(AiKnowledgeBase)
    private readonly kb: Repository<AiKnowledgeBase>,
  ) {}

  /** Retrieves the most relevant knowledge chunks for an agent + query. */
  async retrieve(
    tenantId: string,
    agentId: string,
    query: string,
    limit = 5,
  ): Promise<RetrievedChunk[]> {
    const terms = this.tokenize(query);
    // Candidate set: the agent's chunks (bounded). A vector store would replace
    // this with an ANN search; here we score candidates by term overlap.
    const candidates = await this.kb.find({
      where: { tenant: { id: tenantId }, agent: { id: agentId } },
      order: { created_at: 'DESC' },
      take: 200,
    });

    const scored = candidates
      .map((c) => ({
        id: c.id,
        content: c.content,
        sourceType: c.source_type,
        sourceId: c.source_id,
        score: this.score(c.content, terms),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  /** Builds a single context block from retrieved chunks for prompt assembly. */
  assembleContext(chunks: RetrievedChunk[]): string {
    if (!chunks.length) return '';
    return chunks
      .map((c, i) => `[${i + 1}] (relevance ${c.score.toFixed(2)}) ${c.content}`)
      .join('\n\n');
  }

  private tokenize(text: string): string[] {
    return Array.from(
      new Set(
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .split(/\s+/)
          .filter((t) => t.length > 2),
      ),
    );
  }

  /** Naive relevance: fraction of query terms present in the chunk. */
  private score(content: string, terms: string[]): number {
    if (!terms.length) return 0;
    const lc = content.toLowerCase();
    const hits = terms.filter((t) => lc.includes(t)).length;
    return hits / terms.length;
  }
}

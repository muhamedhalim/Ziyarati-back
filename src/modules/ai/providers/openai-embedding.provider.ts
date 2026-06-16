import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import {
  AiEmbeddingProvider,
  AiEmbeddingResult,
} from './ai-provider.interface';

/**
 * OpenAI embeddings provider (`text-embedding-3-small` by default, 1536 dims).
 *
 * Used only by the RAG + ingestion layers. `isConfigured()` lets callers degrade
 * gracefully (keyword fallback / skip-embedding) when no API key is present, so
 * the app boots without OpenAI.
 *
 * NOTE: a query/chunk embedding cache (Redis, keyed by sha256(model|text)) is the
 * recommended next optimization; the `embed` seam is where it plugs in.
 */
@Injectable()
export class OpenAiEmbeddingProvider implements AiEmbeddingProvider {
  private readonly logger = new Logger('OpenAiEmbeddingProvider');
  private readonly client?: OpenAI;
  private readonly model: string;
  readonly dimension: number;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.model = config.get<string>('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');
    this.dimension = Number(config.get<number>('OPENAI_EMBEDDING_DIM', 1536));
    if (apiKey) this.client = new OpenAI({ apiKey });
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async embed(_tenantId: string, texts: string[]): Promise<AiEmbeddingResult> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    if (texts.length === 0) {
      return { vectors: [], model: this.model, tokens: 0 };
    }
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return {
      vectors: res.data.map((d) => d.embedding as number[]),
      model: this.model,
      tokens: res.usage?.total_tokens ?? 0,
    };
  }
}

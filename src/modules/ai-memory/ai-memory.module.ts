import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiMemory } from '../../entities/AI Agent/AiMemory';
import { AI_EMBEDDING_PROVIDER } from '../ai/providers/ai-provider.interface';
import { OpenAiEmbeddingProvider } from '../ai/providers/openai-embedding.provider';

import { AiMemoryService } from './ai-memory.service';
import { AiMemoryVectorService } from './ai-memory-vector.service';
import { AiMemoryController } from './ai-memory.controller';

/**
 * Long-term AI memory (Feature 5). Reuses the EXISTING embedding provider class
 * (bound to the shared `AI_EMBEDDING_PROVIDER` token) + the pgvector pattern —
 * no embedding/vector logic is duplicated. Exports `AiMemoryService` so the
 * orchestrator can recall memories and the worker can purge expired ones.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AiMemory])],
  controllers: [AiMemoryController],
  providers: [
    AiMemoryService,
    AiMemoryVectorService,
    { provide: AI_EMBEDDING_PROVIDER, useClass: OpenAiEmbeddingProvider },
  ],
  exports: [AiMemoryService],
})
export class AiMemoryModule {}

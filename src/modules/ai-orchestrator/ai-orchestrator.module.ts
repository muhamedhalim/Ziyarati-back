import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { AiModule } from '../ai/ai.module';
import { AiMemoryModule } from '../ai-memory/ai-memory.module';

import { AiSessionModule } from '../ai-session/ai-session.module';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AgentRouterService } from './agent-router.service';
import { AiOrchestratorController } from './ai-orchestrator.controller';

/**
 * AI Orchestration layer (Phases 2, 3, 5) — the cross-channel entry point + the
 * conversation session manager, layered ABOVE the existing AI engine.
 *
 * Imports `AiModule` to REUSE `AiConversationService` + `AiExecutionService`
 * (RAG, tools, provider, metering) — it adds no parallel AI logic. Session state
 * lives on the existing `ai_conversations` row (forFeature for the repo).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AiConversation, AiAgent]),
    AiModule,
    AiMemoryModule,
    // ConversationSessionService now lives here (see AiSessionModule).
    AiSessionModule,
  ],
  controllers: [AiOrchestratorController],
  providers: [AiOrchestratorService, AgentRouterService],
  // Re-export AiSessionModule so importers keep resolving
  // ConversationSessionService from this module, unchanged.
  exports: [AiOrchestratorService, AiSessionModule, AgentRouterService],
})
export class AiOrchestratorModule {}

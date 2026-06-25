import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { AiKnowledgeBase } from '../../entities/AI Agent/AiKnowledgeBase';
import { AiTrainingFile } from '../../entities/AI Agent/AiTrainingFile';
import { AiPrompt } from '../../entities/AI Agent/AiPrompt';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { AiUsageLog } from '../../entities/AI Agent/AiUsageLog';
import { AiCostLog } from '../../entities/AI Agent/AiCostLog';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Conversation } from '../../entities/Conversations/Conversation';
import { User } from '../../entities/Auth&RBAC/User';

import { AiAgentService } from './ai-agent.service';
import { AiKnowledgeBaseService } from './ai-knowledge-base.service';
import { AiTrainingFileService } from './ai-training-file.service';
import { AiPromptService } from './ai-prompt.service';
import { AiConversationService } from './ai-conversation.service';
import { AiMessageService } from './ai-message.service';
import { AiRagService } from './ai-rag.service';
import { AiExecutionService } from './ai-execution.service';
import { AiAnalyticsService } from './ai-analytics.service';
import { HandoverRequestService } from './handover-request.service';

import { AiAgentController } from './ai-agent.controller';
import { AiKnowledgeBaseController } from './ai-knowledge-base.controller';
import { AiTrainingFileController } from './ai-training-file.controller';
import { AiPromptController } from './ai-prompt.controller';
import { AiConversationController } from './ai-conversation.controller';
import { AiAnalyticsController } from './ai-analytics.controller';
import { HandoverRequestController } from './handover-request.controller';

import { AiProviderFactory } from './providers/ai-provider.factory';
import { NoopAiProvider } from './providers/noop-ai.provider';
import { OpenAiChatProvider } from './providers/openai-chat.provider';
import { OpenAiEmbeddingProvider } from './providers/openai-embedding.provider';
import {
  AI_COMPLETION_PROVIDERS,
  AI_EMBEDDING_PROVIDER,
} from './providers/ai-provider.interface';
import { PgVectorBootstrapService } from './rag/pgvector-bootstrap.service';
import { AiKnowledgeIngestionService } from './ingestion/ai-knowledge-ingestion.service';
import { AiToolDispatchService } from './tools/ai-tool-dispatch.service';
import { AiToolCallsBootstrap } from './tools/ai-tool-calls.bootstrap';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { AppointmentModule } from '../appointment/appointment.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { PlatformModule } from '../platform/platform.module';

/**
 * AI / RAG Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService (tenant scope), and the global
 * JwtAuthGuard.
 *
 * Provider-agnostic: real LLM adapters (OpenAI/Anthropic/Azure) register into the
 * AI_COMPLETION_PROVIDERS multi-provider token; AiProviderFactory resolves one,
 * falling back to NoopAiProvider. AiExecutionService is the single RAG turn
 * orchestrator (retrieve → assemble → provider → persist + meter usage/cost).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiAgent,
      AiKnowledgeBase,
      AiTrainingFile,
      AiPrompt,
      AiConversation,
      AiMessage,
      AiUsageLog,
      AiCostLog,
      HandoverRequest,
      Branch,
      Conversation,
      User,
    ]),
    // Usage-quota enforcement (UsageService) for AI token metering.
    SubscriptionBillingModule,
    // Booking toolset: reuse the existing transactional booking + availability
    // engines — the AI never duplicates booking logic.
    AppointmentModule,
    SchedulingModule,
    // Timeline unification: mirror AI turns into the Conversation/Message store
    // (ConversationExecutionService) so agents read a single history.
    ConversationsModule,
    // Provides SystemSettingService for default model/temperature when creating agents.
    PlatformModule,
  ],
  controllers: [
    AiAgentController,
    AiKnowledgeBaseController,
    AiTrainingFileController,
    AiPromptController,
    AiConversationController,
    AiAnalyticsController,
    HandoverRequestController,
  ],
  providers: [
    AiAgentService,
    AiKnowledgeBaseService,
    AiTrainingFileService,
    AiPromptService,
    AiConversationService,
    AiMessageService,
    AiRagService,
    AiExecutionService,
    AiAnalyticsService,
    HandoverRequestService,
    AiToolDispatchService,
    AiToolCallsBootstrap,
    AiProviderFactory,
    NoopAiProvider,
    OpenAiChatProvider,
    PgVectorBootstrapService,
    AiKnowledgeIngestionService,
    // Embedding backend (RAG + ingestion only). Falls back to keyword retrieval
    // when no API key is configured (provider.isConfigured() === false).
    { provide: AI_EMBEDDING_PROVIDER, useClass: OpenAiEmbeddingProvider },
    // Completion providers: OpenAI first, Noop fallback resolved by the factory.
    {
      provide: AI_COMPLETION_PROVIDERS,
      useFactory: (openai: OpenAiChatProvider) => [openai],
      inject: [OpenAiChatProvider],
    },
  ],
  exports: [
    AiAgentService,
    AiKnowledgeBaseService,
    AiConversationService,
    AiExecutionService,
    AiRagService,
    HandoverRequestService,
  ],
})
export class AiModule {}

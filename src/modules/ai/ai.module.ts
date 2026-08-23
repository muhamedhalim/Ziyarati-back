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
import { AiExecutionMetric } from '../../entities/AI Agent/AiExecutionMetric';
import { AiBatchJob } from '../../entities/AI Agent/AiBatchJob';
import { AiBatchItem } from '../../entities/AI Agent/AiBatchItem';
import { TenantAiDeployment } from '../../entities/AI Agent/TenantAiDeployment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Conversation } from '../../entities/Conversations/Conversation';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';

import { AiAgentService } from './ai-agent.service';
import { AiKnowledgeBaseService } from './ai-knowledge-base.service';
import { AiTrainingFileService } from './ai-training-file.service';
import { AiPromptService } from './ai-prompt.service';
import { AiConversationService } from './ai-conversation.service';
import { AiMessageService } from './ai-message.service';
import { AiRagService } from './ai-rag.service';
import { AiExecutionService } from './ai-execution.service';
import { AiAnalyticsService } from './ai-analytics.service';
import { AiMetricsService } from './ai-metrics.service';
import { HandoverRequestService } from './handover-request.service';

import { AiAgentController } from './ai-agent.controller';
import { AiKnowledgeBaseController } from './ai-knowledge-base.controller';
import { AiTrainingFileController } from './ai-training-file.controller';
import { AiPromptController } from './ai-prompt.controller';
import { AiConversationController } from './ai-conversation.controller';
import { AiAnalyticsController } from './ai-analytics.controller';
import { AiMetricsController } from './ai-metrics.controller';
import { AiToolCatalogController } from './ai-tool-catalog.controller';
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
import { AiToolCallRetentionService } from './tools/ai-tool-call-retention.service';
import { AiSessionModule } from '../ai-session/ai-session.module';
import { AiBotActorModule } from '../ai-bot-actor/ai-bot-actor.module';
import { PublicBookingModule } from '../public-booking/public-booking.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { AppointmentModule } from '../appointment/appointment.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { PlatformModule } from '../platform/platform.module';
import { PublicDiscoveryModule } from '../public-discovery/public-discovery.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { StaffModule } from '../staff/staff.module';
import { CrmModule } from '../crm/crm.module';
import { StorageModule } from '../storage/storage.module';
import { AiAttachmentModule } from '../ai-attachment/ai-attachment.module';
import { TenantModule } from '../tenant/tenant.module';
import { PaymentsModule } from '../payments/payments.module';
import { AiPriceCatalogService } from './cost/ai-price-catalog.service';
import { AiCostLedgerService } from './cost/ai-cost-ledger.service';
import { AiPromptBudgetService } from './prompt/ai-prompt-budget.service';
import { AiRequestExecutionService } from './idempotency/ai-request-execution.service';
import { AiModelRouterService } from './routing/ai-model-router.service';
import { AiExecutionPolicyService } from './execution/ai-execution-policy.service';
import { AiDataResidencyService } from './execution/ai-data-residency.service';
import { AiProcessingPolicyService } from './execution/ai-processing-policy.service';
import { OpenAiClientProvider } from './providers/openai-client.provider';
import { OpenAiBatchProvider } from './providers/openai-batch.provider';
import { AI_BATCH_PROVIDER } from './providers/ai-batch-provider.interface';
import { AiBatchService } from './batch/ai-batch.service';

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
      AiExecutionMetric,
      AiBatchJob,
      AiBatchItem,
      TenantAiDeployment,
      Branch,
      Conversation,
      User,
      UserRole,
    ]),
    // Conversation ownership + session state (shared with the public booking
    // flow; see AiSessionModule for why they were hoisted out).
    AiSessionModule,
    // Public AI booking: resolves the SELECTED clinic's tenant server-side from
    // the persisted branch selection, so the booking tools never take a tenantId.
    PublicBookingModule,
    // The selected clinic's own least-privilege `ai-bot` actor — public
    // bookings execute as it, so a guest never needs clinic permissions.
    AiBotActorModule,
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
    // Public discovery tools: the model can search clinics / branches / doctors /
    // services / free slots in-conversation (reuses PublicDiscoveryService).
    PublicDiscoveryModule,
    // Dashboard Assistant admin toolset: reuses the tenant's own read services —
    // no duplicated queries. Every call is additionally permission-gated in
    // AiToolDispatchService against the acting user's real permissions.
    AnalyticsModule,
    StaffModule,
    CrmModule,
    StorageModule,
    // Provides TenantService (payment_required business rule) and
    // PaymentLinkService (auto-generated payment link for uninsured
    // bookings) for the AI booking flow's deterministic payment decision.
    TenantModule,
    PaymentsModule,
    // Redis custody of chat attachments uploaded before the turn that uses
    // them. Read-only from here: the execution service redeems a staged
    // descriptor into the conversation's session; nothing in AiModule writes
    // one (that is the guest upload endpoint's job).
    AiAttachmentModule,
  ],
  controllers: [
    AiAgentController,
    AiKnowledgeBaseController,
    AiTrainingFileController,
    AiPromptController,
    AiConversationController,
    AiAnalyticsController,
    AiMetricsController,
    AiToolCatalogController,
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
    AiMetricsService,
    HandoverRequestService,
    AiToolDispatchService,
    AiToolCallsBootstrap,
    AiToolCallRetentionService,
    AiProviderFactory,
    NoopAiProvider,
    OpenAiChatProvider,
    PgVectorBootstrapService,
    AiKnowledgeIngestionService,
    AiPriceCatalogService,
    AiCostLedgerService,
    AiPromptBudgetService,
    AiRequestExecutionService,
    AiModelRouterService,
    // Execution mode (Standard/Batch) + Data Residency (compliance) + the OpenAI
    // Batch orchestrator. All gated by feature flags (default OFF).
    AiExecutionPolicyService,
    AiDataResidencyService,
    // Composes the two above into one per-request decision. Owns no rules.
    AiProcessingPolicyService,
    OpenAiClientProvider,
    OpenAiBatchProvider,
    AiBatchService,
    { provide: AI_BATCH_PROVIDER, useClass: OpenAiBatchProvider },
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
    // Re-exported so existing consumers (the realtime gateway, the
    // orchestrator) keep resolving it from AiModule as they always did.
    AiSessionModule,
    AiExecutionService,
    AiRagService,
    AiMetricsService,
    HandoverRequestService,
    AI_EMBEDDING_PROVIDER,
    AiCostLedgerService,
    AiPromptBudgetService,
    AiModelRouterService,
    AiExecutionPolicyService,
    AiDataResidencyService,
    AiProcessingPolicyService,
    AiBatchService,
    AiTrainingFileService,
    // Single seam for provider-agnostic completions — reused by the billing
    // upgrade domain's advisory AI cost-estimation service.
    AiProviderFactory,
    // Resolved by AiProcessor (WorkerModule) for the retention sweep job branch.
    AiToolCallRetentionService,
  ],
})
export class AiModule {}

import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
// READ-ONLY: `WhatsappTemplateService.remove` refuses to delete a template a
// notification template still points at.
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { WhatsappWebhook } from '../../entities/WhatsApp/WhatsappWebhook';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { Customer } from '../../entities/CRM/Customer';
import { User } from '../../entities/Auth&RBAC/User';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Conversation } from '../../entities/Conversations/Conversation';
import { Message } from '../../entities/Conversations/Message';
import { MessageAttachment } from '../../entities/Conversations/MessageAttachment';
import { MessageStatusLog } from '../../entities/Conversations/MessageStatusLog';

import { WhatsappAccountService } from './whatsapp-account.service';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappWebhookService } from './whatsapp-webhook.service';
import { WhatsappDlqService } from './whatsapp-dlq.service';
import { WhatsappContactService } from './whatsapp-contact.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappExecutionService } from './whatsapp-execution.service';
import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WhatsappAiPolicyService } from './whatsapp-ai-policy.service';
import { WhatsappAiHoursService } from './whatsapp-ai-hours.service';
import { WorkingHour } from '../../entities/Staff/WorkingHour';
import { ContactTurnLockService } from './contact-turn-lock.service';
import { AiBotActorModule } from '../ai-bot-actor/ai-bot-actor.module';
import { WhatsappAnalyticsService } from './whatsapp-analytics.service';

import { WhatsappAccountController } from './whatsapp-account.controller';
import { WhatsappTemplateController } from './whatsapp-template.controller';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappDlqController } from './whatsapp-dlq.controller';
import { WhatsappContactController } from './whatsapp-contact.controller';
import { WhatsappAnalyticsController } from './whatsapp-analytics.controller';

import { WhatsappProviderFactory } from './providers/whatsapp-provider.factory';
import { NoopWhatsappProvider } from './providers/noop-whatsapp.provider';
import { MetaWhatsappProvider } from './providers/meta-whatsapp.provider';
import {
  WHATSAPP_MESSAGE_PROVIDERS,
  WhatsappMessageProvider,
} from './providers/whatsapp-message.provider.interface';
import { WebhookSignatureVerifier } from './webhooks/webhook-signature.verifier';
import { WhatsappAccountResolver } from './routing/whatsapp-account.resolver';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { MetaConfig } from './meta/meta.config';
import { MetaGraphClient } from './meta/meta-graph.client';
import { MetaEmbeddedSignupService } from './meta/meta-embedded-signup.service';
import { WhatsappTemplateSyncService } from './meta/whatsapp-template-sync.service';
import { WhatsappMediaService } from './meta/whatsapp-media.service';
import { WhatsappCoexistenceSyncService } from './meta/whatsapp-coexistence-sync.service';
import { WhatsappCoexistenceEchoService } from './meta/whatsapp-coexistence-echo.service';
import { WhatsappOnboardingController } from './meta/whatsapp-onboarding.controller';
import { StorageModule } from '../storage/storage.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { AuthModule } from '../auth/auth.module';
import { CrmModule } from '../crm/crm.module';
// FND-024: opt-out keyword list is a platform SystemSetting (data, not
// hardcoded — extensible without a deploy). PlatformModule imports no other
// feature module, so this introduces no circular dependency.
import { PlatformModule } from '../platform/platform.module';
// Not imported via CampaignsModule (which itself imports WhatsappModule —
// that would make it circular). RecipientDeliveryService depends only on
// DataSource, so providing the same stateless class here too is the minimal
// way to close the "campaign delivery status never updates from the real
// Meta webhook" gap without restructuring module boundaries.
import { RecipientDeliveryService } from '../campaigns/recipient-delivery.service';
// FND-023 — same reasoning as RecipientDeliveryService immediately above:
// not imported via ConversationsModule (avoids reasoning about a second
// potential cycle through it) — MessageStatusService depends only on the
// Message/MessageStatusLog repositories (both registered below), so
// providing the same stateless class here too is the minimal way to route
// delivery/read status to the unified conversation timeline.
import { MessageStatusService } from '../conversations/message-status.service';
// FND-023 — same reasoning again: ConversationExecutionService depends only
// on Message/Conversation repositories + MessageStatusService (all available
// in this module already) + DataSource, so it's provided directly rather
// than importing ConversationsModule. Used by WhatsappInboundAiService to
// attach a bot reply's provider message id once its send completes.
import { ConversationExecutionService } from '../conversations/conversation-execution.service';
// Same reasoning once more: the coexistence echo stamps the automatic human
// takeover, and ConversationAiTakeoverService depends only on the Conversation
// and TenantSetting repositories this module already registers.
import { ConversationAiTakeoverService } from '../conversations/conversation-ai-takeover.service';
import { AiWsRateLimitService } from '../ai-realtime/ai-ws-rate-limit.service';

/**
 * WhatsApp Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService (tenant scope), and the global
 * JwtAuthGuard.
 *
 * Delivery is decoupled behind a strategy/factory: real providers (Meta Cloud
 * API / Twilio / 360dialog) register into WHATSAPP_MESSAGE_PROVIDERS (empty for
 * now); WhatsappProviderFactory resolves one, falling back to NoopWhatsappProvider.
 * Sends are recorded on `notification_logs` (channel WHATSAPP) — the analytics
 * source of truth (there is no dedicated WhatsApp message table).
 *
 * Webhook signature verification & verify-token are config-driven abstractions
 * (no DB columns exist for them).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      WhatsappAccount,
      WhatsappTemplate,
      NotificationTemplate,
      WhatsappWebhook,
      WhatsappContact,
      NotificationLog,
      Branch,
      Customer,
      User,
      // Inbound media attaches to the unified timeline. Read/write is confined
      // to WhatsappMediaService — conversation business logic stays in
      // ConversationsModule.
      Message,
      MessageAttachment,
      // FND-023 — MessageStatusService's and ConversationExecutionService's
      // own repository dependencies (see the provider import comments below).
      MessageStatusLog,
      Conversation,
      // DLQ admin actions write a safe audit record (FND-002, FR-013).
      AuditLog,
      // READ-ONLY: `bot_enabled`, the clinic's own switch for the inbound AI
      // auto-reply (`WhatsappAiPolicyService`).
      TenantSetting,
      // READ-ONLY: the clinic's working hours, for the AI schedule mode
      // (`WhatsappAiHoursService`).
      WorkingHour,
      // READ-ONLY: the contact's AI session, to find the timeline thread it is
      // already bound to (`WhatsappInboundAiService.storeOnTimeline`).
      AiConversation,
    ]),
    // Usage-quota enforcement (UsageService) for WhatsApp message metering.
    SubscriptionBillingModule,
    ConfigModule,
    // Two-way: WhatsApp sends notifications; notification webhooks record delivery.
    forwardRef(() => NotificationsModule),
    // Inbound automation: reuse the single cross-channel AI orchestrator (no AI
    // logic duplicated here — the bridge only maps WhatsApp ⇄ orchestrator).
    AiOrchestratorModule,
    // The `ai-bot` principal inbound turns act as. Registered in its own module
    // so the public web booking flow can reuse the same actor without
    // importing WhatsappModule (which would cycle back through AiModule).
    AiBotActorModule,
    // Bot Actor identity: reuses RolesService/AuthService (real users + RBAC,
    // no parallel auth) and CustomerService (CRM customer linkage) — no new
    // business logic, just composing the existing services.
    AuthModule,
    CrmModule,
    PlatformModule,
    // Inbound media is stored in the SAME private R2 bucket as verification
    // documents (tenant-prefixed keys, signed-URL reads) — no second storage
    // implementation, just a different upload policy.
    StorageModule,
  ],
  controllers: [
    WhatsappAccountController,
    WhatsappTemplateController,
    WhatsappWebhookController,
    WhatsappDlqController,
    WhatsappContactController,
    WhatsappAnalyticsController,
    WhatsappOnboardingController,
  ],
  providers: [
    WhatsappAccountService,
    WhatsappTemplateService,
    WhatsappWebhookService,
    WhatsappDlqService,
    WhatsappContactService,
    WhatsappMessagingService,
    WhatsappExecutionService,
    WhatsappInboundAiService,
    // The single decision on whether the AI may answer (clinic switch, plan,
    // human takeover), asked before the model runs and again before the send.
    WhatsappAiPolicyService,
    WhatsappAiHoursService,
    // Serializes AI turns per contact (the webhook worker runs concurrently).
    ContactTurnLockService,
    // F-16: per-contact admission for WhatsappInboundAiService. The realtime
    // gateway provides the same class; it depends only on Redis and config, and
    // importing AiRealtimeModule here would be a cycle (it imports this module).
    AiWsRateLimitService,
    WhatsappAnalyticsService,
    WhatsappProviderFactory,
    NoopWhatsappProvider,
    MetaWhatsappProvider,
    WebhookSignatureVerifier,
    WhatsappAccountResolver,
    WhatsappMessageRouter,
    // Meta Tech Provider layer: platform app config, the single Graph API
    // transport, Embedded Signup onboarding, and the template mirror.
    MetaConfig,
    MetaGraphClient,
    MetaEmbeddedSignupService,
    WhatsappTemplateSyncService,
    WhatsappMediaService,
    WhatsappCoexistenceSyncService,
    WhatsappCoexistenceEchoService,
    RecipientDeliveryService,
    MessageStatusService,
    ConversationExecutionService,
    ConversationAiTakeoverService,
    // REAL provider registered into the strategy token (per-tenant credentials,
    // approved template sends). NoopWhatsappProvider stays only as the factory's
    // typed fallback dependency and is never resolved (Meta supports() === true).
    {
      provide: WHATSAPP_MESSAGE_PROVIDERS,
      useFactory: (meta: MetaWhatsappProvider): WhatsappMessageProvider[] => [
        meta,
      ],
      inject: [MetaWhatsappProvider],
    },
  ],
  exports: [
    WhatsappAccountService,
    WhatsappTemplateService,
    WhatsappContactService,
    WhatsappMessagingService,
    WhatsappExecutionService,
    // Needed by WorkflowActionExecutor (WHATSAPP action) to resolve the
    // sending account the same way WhatsappInboundAiService does.
    WhatsappMessageRouter,
    // Campaigns validate template↔account WABA matching against the resolver.
    WhatsappAccountResolver,
    WhatsappTemplateSyncService,
    // Consumed by the worker's whatsapp-webhook / whatsapp-media / whatsapp
    // (outbound) processors.
    WhatsappWebhookService,
    WhatsappMediaService,
    WhatsappCoexistenceSyncService,
    // Other modules (conversation controls) ask the same question the bridge does.
    WhatsappAiPolicyService,
  ],
})
export class WhatsappModule {}

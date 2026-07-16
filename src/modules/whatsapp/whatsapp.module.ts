import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappWebhook } from '../../entities/WhatsApp/WhatsappWebhook';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';
import { User } from '../../entities/Auth&RBAC/User';
import { Message } from '../../entities/Conversations/Message';
import { MessageAttachment } from '../../entities/Conversations/MessageAttachment';

import { WhatsappAccountService } from './whatsapp-account.service';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappWebhookService } from './whatsapp-webhook.service';
import { WhatsappContactService } from './whatsapp-contact.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappExecutionService } from './whatsapp-execution.service';
import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WhatsappBotActorService } from './whatsapp-bot-actor.service';
import { WhatsappAnalyticsService } from './whatsapp-analytics.service';

import { WhatsappAccountController } from './whatsapp-account.controller';
import { WhatsappTemplateController } from './whatsapp-template.controller';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
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
import { WhatsappOnboardingController } from './meta/whatsapp-onboarding.controller';
import { StorageModule } from '../storage/storage.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { AuthModule } from '../auth/auth.module';
import { CrmModule } from '../crm/crm.module';

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
    ]),
    // Usage-quota enforcement (UsageService) for WhatsApp message metering.
    SubscriptionBillingModule,
    ConfigModule,
    // Two-way: WhatsApp sends notifications; notification webhooks record delivery.
    forwardRef(() => NotificationsModule),
    // Inbound automation: reuse the single cross-channel AI orchestrator (no AI
    // logic duplicated here — the bridge only maps WhatsApp ⇄ orchestrator).
    AiOrchestratorModule,
    // Bot Actor identity: reuses RolesService/AuthService (real users + RBAC,
    // no parallel auth) and CustomerService (CRM customer linkage) — no new
    // business logic, just composing the existing services.
    AuthModule,
    CrmModule,
    // Inbound media is stored in the SAME private R2 bucket as verification
    // documents (tenant-prefixed keys, signed-URL reads) — no second storage
    // implementation, just a different upload policy.
    StorageModule,
  ],
  controllers: [
    WhatsappAccountController,
    WhatsappTemplateController,
    WhatsappWebhookController,
    WhatsappContactController,
    WhatsappAnalyticsController,
    WhatsappOnboardingController,
  ],
  providers: [
    WhatsappAccountService,
    WhatsappTemplateService,
    WhatsappWebhookService,
    WhatsappContactService,
    WhatsappMessagingService,
    WhatsappExecutionService,
    WhatsappInboundAiService,
    WhatsappBotActorService,
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
    // REAL provider registered into the strategy token (per-tenant credentials,
    // approved template sends). NoopWhatsappProvider stays only as the factory's
    // typed fallback dependency and is never resolved (Meta supports() === true).
    {
      provide: WHATSAPP_MESSAGE_PROVIDERS,
      useFactory: (meta: MetaWhatsappProvider): WhatsappMessageProvider[] => [meta],
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
    // Consumed by the worker's whatsapp-webhook / whatsapp-media processors.
    WhatsappWebhookService,
    WhatsappMediaService,
  ],
})
export class WhatsappModule {}

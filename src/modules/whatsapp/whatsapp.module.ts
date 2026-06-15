import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappWebhook } from '../../entities/WhatsApp/WhatsappWebhook';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';

import { WhatsappAccountService } from './whatsapp-account.service';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappWebhookService } from './whatsapp-webhook.service';
import { WhatsappContactService } from './whatsapp-contact.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { WhatsappExecutionService } from './whatsapp-execution.service';
import { WhatsappAnalyticsService } from './whatsapp-analytics.service';

import { WhatsappAccountController } from './whatsapp-account.controller';
import { WhatsappTemplateController } from './whatsapp-template.controller';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappContactController } from './whatsapp-contact.controller';
import { WhatsappAnalyticsController } from './whatsapp-analytics.controller';

import { WhatsappProviderFactory } from './providers/whatsapp-provider.factory';
import { NoopWhatsappProvider } from './providers/noop-whatsapp.provider';
import { WHATSAPP_MESSAGE_PROVIDERS } from './providers/whatsapp-message.provider.interface';
import { WebhookSignatureVerifier } from './webhooks/webhook-signature.verifier';
import { WhatsappAccountResolver } from './routing/whatsapp-account.resolver';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';

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
    ]),
  ],
  controllers: [
    WhatsappAccountController,
    WhatsappTemplateController,
    WhatsappWebhookController,
    WhatsappContactController,
    WhatsappAnalyticsController,
  ],
  providers: [
    WhatsappAccountService,
    WhatsappTemplateService,
    WhatsappWebhookService,
    WhatsappContactService,
    WhatsappMessagingService,
    WhatsappExecutionService,
    WhatsappAnalyticsService,
    WhatsappProviderFactory,
    NoopWhatsappProvider,
    WebhookSignatureVerifier,
    WhatsappAccountResolver,
    WhatsappMessageRouter,
    // No real WhatsApp providers yet — the array is the registration point.
    { provide: WHATSAPP_MESSAGE_PROVIDERS, useValue: [] },
  ],
  exports: [
    WhatsappAccountService,
    WhatsappTemplateService,
    WhatsappContactService,
    WhatsappMessagingService,
    WhatsappExecutionService,
  ],
})
export class WhatsappModule {}

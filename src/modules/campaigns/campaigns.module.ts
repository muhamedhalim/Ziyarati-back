import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Customer } from '../../entities/CRM/Customer';

import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

import { CampaignService } from './campaign.service';
import { CampaignRecipientService } from './campaign-recipient.service';
import { CampaignRunService } from './campaign-run.service';
import { CampaignExecutionService } from './campaign-execution.service';
import { CampaignFanoutService } from './campaign-fanout.service';
import { CampaignDispatchService } from './campaign-dispatch.service';
import { CampaignAnalyticsService } from './campaign-analytics.service';
import { CampaignDlqService } from './campaign-dlq.service';
import { RecipientDeliveryService } from './recipient-delivery.service';

import { CampaignController } from './campaign.controller';
import { CampaignRecipientController } from './campaign-recipient.controller';
import { CampaignAnalyticsController } from './campaign-analytics.controller';
import { CampaignDlqController } from './campaign-dlq.controller';
import { RecipientDeliveryController } from './recipient-delivery.controller';

import { CampaignDeliveryFactory } from './delivery/campaign-delivery.factory';
import { NoopCampaignDeliveryProvider } from './delivery/noop-campaign-delivery.provider';
import { WhatsappCampaignDeliveryProvider } from './delivery/whatsapp-campaign-delivery.provider';
import {
  CAMPAIGN_DELIVERY_PROVIDERS,
  CampaignDeliveryProvider,
} from './delivery/campaign-delivery.provider.interface';

/**
 * Campaigns Domain — queue-native execution.
 *
 *  - Lifecycle (operator intent)        → CampaignExecutionService (+ outbox).
 *  - Run aggregate + counters           → CampaignRun / CampaignRunService.
 *  - Scalable fan-out (worker)          → CampaignFanoutService.
 *  - Per-recipient send seam (worker)   → CampaignDispatchService.
 *  - Analytics from materialized counts → CampaignAnalyticsService.
 *  - Dead-letter admin                  → CampaignDlqService / Controller.
 *
 * Delivery stays decoupled behind the CAMPAIGN_DELIVERY_PROVIDERS strategy.
 * QueueService + TenantRateLimiterService come from the @Global QueueModule.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Campaign,
      CampaignRun,
      CampaignRecipient,
      OutboxJob,
      WhatsappTemplate,
      // Read-only here: campaigns validate the number they send FROM belongs to
      // the tenant. Account lifecycle stays in WhatsappModule.
      WhatsappAccount,
      Customer,
    ]),
    SubscriptionBillingModule,
    // Real WhatsApp delivery: WhatsappCampaignDeliveryProvider delegates to
    // WhatsappExecutionService rather than re-implementing the send path.
    WhatsappModule,
  ],
  controllers: [
    CampaignController,
    CampaignRecipientController,
    CampaignAnalyticsController,
    CampaignDlqController,
    RecipientDeliveryController,
  ],
  providers: [
    CampaignService,
    CampaignRecipientService,
    CampaignRunService,
    CampaignExecutionService,
    CampaignFanoutService,
    CampaignDispatchService,
    CampaignAnalyticsService,
    CampaignDlqService,
    RecipientDeliveryService,
    CampaignDeliveryFactory,
    NoopCampaignDeliveryProvider,
    WhatsappCampaignDeliveryProvider,
    // REAL provider registered into the strategy token. Previously this was an
    // empty array, which silently routed EVERY campaign send to the no-op
    // provider — runs completed "successfully" having sent nothing. The noop
    // now only serves channels with no real adapter yet (SMS/EMAIL/PUSH/IN_APP).
    {
      provide: CAMPAIGN_DELIVERY_PROVIDERS,
      useFactory: (whatsapp: WhatsappCampaignDeliveryProvider): CampaignDeliveryProvider[] => [
        whatsapp,
      ],
      inject: [WhatsappCampaignDeliveryProvider],
    },
  ],
  exports: [
    CampaignService,
    CampaignRecipientService,
    CampaignRunService,
    CampaignExecutionService,
    CampaignFanoutService,
    CampaignDispatchService,
    CampaignAnalyticsService,
    CampaignDlqService,
    RecipientDeliveryService,
  ],
})
export class CampaignsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { Customer } from '../../entities/CRM/Customer';

import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';

import { CampaignService } from './campaign.service';
import { CampaignRecipientService } from './campaign-recipient.service';
import { CampaignRunService } from './campaign-run.service';
import { CampaignExecutionService } from './campaign-execution.service';
import { CampaignFanoutService } from './campaign-fanout.service';
import { CampaignDispatchService } from './campaign-dispatch.service';
import { CampaignAnalyticsService } from './campaign-analytics.service';
import { CampaignDlqService } from './campaign-dlq.service';

import { CampaignController } from './campaign.controller';
import { CampaignRecipientController } from './campaign-recipient.controller';
import { CampaignAnalyticsController } from './campaign-analytics.controller';
import { CampaignDlqController } from './campaign-dlq.controller';

import { CampaignDeliveryFactory } from './delivery/campaign-delivery.factory';
import { NoopCampaignDeliveryProvider } from './delivery/noop-campaign-delivery.provider';
import { CAMPAIGN_DELIVERY_PROVIDERS } from './delivery/campaign-delivery.provider.interface';

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
      Customer,
    ]),
    SubscriptionBillingModule,
  ],
  controllers: [
    CampaignController,
    CampaignRecipientController,
    CampaignAnalyticsController,
    CampaignDlqController,
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
    CampaignDeliveryFactory,
    NoopCampaignDeliveryProvider,
    { provide: CAMPAIGN_DELIVERY_PROVIDERS, useValue: [] },
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
  ],
})
export class CampaignsModule {}

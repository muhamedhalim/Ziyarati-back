import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { Customer } from '../../entities/CRM/Customer';

import { CampaignService } from './campaign.service';
import { CampaignRecipientService } from './campaign-recipient.service';
import { CampaignExecutionService } from './campaign-execution.service';
import { CampaignAnalyticsService } from './campaign-analytics.service';

import { CampaignController } from './campaign.controller';
import { CampaignRecipientController } from './campaign-recipient.controller';
import { CampaignAnalyticsController } from './campaign-analytics.controller';

import { CampaignDeliveryFactory } from './delivery/campaign-delivery.factory';
import { NoopCampaignDeliveryProvider } from './delivery/noop-campaign-delivery.provider';
import { CAMPAIGN_DELIVERY_PROVIDERS } from './delivery/campaign-delivery.provider.interface';

/**
 * Campaigns Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService (tenant scope), and the global
 * JwtAuthGuard.
 *
 * Delivery is decoupled behind a strategy/factory: concrete providers
 * (WhatsApp/SMS/Email/Push/In-App) register into the CAMPAIGN_DELIVERY_PROVIDERS
 * multi-provider array (empty for now); CampaignDeliveryFactory resolves one per
 * dispatch, falling back to NoopCampaignDeliveryProvider. CampaignExecutionService
 * is the queue-ready seam (schedule/launch = produce; `dispatchRecipient` = the
 * per-recipient send a future BullMQ worker calls).
 *
 * Exports the services so other domains can enroll recipients / trigger
 * campaigns programmatically.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Campaign,
      CampaignRecipient,
      WhatsappTemplate,
      Customer,
    ]),
  ],
  controllers: [
    CampaignController,
    CampaignRecipientController,
    CampaignAnalyticsController,
  ],
  providers: [
    CampaignService,
    CampaignRecipientService,
    CampaignExecutionService,
    CampaignAnalyticsService,
    CampaignDeliveryFactory,
    NoopCampaignDeliveryProvider,
    // No real delivery providers yet — the array is the registration point.
    { provide: CAMPAIGN_DELIVERY_PROVIDERS, useValue: [] },
  ],
  exports: [
    CampaignService,
    CampaignRecipientService,
    CampaignExecutionService,
    CampaignAnalyticsService,
  ],
})
export class CampaignsModule {}

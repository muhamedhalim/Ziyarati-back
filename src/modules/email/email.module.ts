import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailLog } from '../../entities/System/EmailLog';
import { EmailSuppression } from '../../entities/System/EmailSuppression';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Customer } from '../../entities/CRM/Customer';

import { EmailService } from './email.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailProviderFactory } from './providers/email-provider.factory';
import { SesProvider } from './providers/ses.provider';
import { NoopEmailProvider } from './providers/noop-email.provider';
import { EmailLogController } from './email-log.controller';

import { EmailSuppressionService } from './email-suppression.service';
import { UnsubscribeTokenService } from './unsubscribe-token.service';
import { UnsubscribeService } from './unsubscribe.service';
import { UnsubscribeController } from './unsubscribe.controller';

import { CampaignsModule } from '../campaigns/campaigns.module';

/**
 * Email infrastructure. `EmailService` is the single business entry point (no
 * module calls a provider directly); providers sit behind
 * {@link EmailProviderFactory}. Global so any domain (auth, subscriptions,
 * appointments, …) can inject `EmailService` without re-importing. Imported in
 * BOTH the API root (AppModule) and the worker root (WorkerModule) — the worker's
 * EmailProcessor reuses {@link EmailDeliveryService} to deliver queued emails.
 *
 * Phase 11 (US7) additions: the per-tenant suppression list + the public
 * unsubscribe surface (T134). Bounce/complaint feedback arrives through the
 * SES → SNS → SQS consumer on the worker (there is no public webhook). The
 * module imports `CampaignsModule` for `RecipientDeliveryService` (resolving
 * a `provider_ref` back to a recipient) and `CampaignAuditService`
 * (T139) — a ONE-DIRECTION import; `CampaignsModule` never imports
 * `EmailModule` back (it doesn't need to: `EmailModule` is `@Global()`, so
 * `EmailCampaignDeliveryProvider`/`EmailSuppressionService` are already
 * available everywhere without one).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([EmailLog, EmailSuppression, Tenant, Customer]),
    CampaignsModule,
  ],
  controllers: [EmailLogController, UnsubscribeController],
  providers: [
    EmailService,
    EmailDeliveryService,
    EmailProviderFactory,
    SesProvider,
    NoopEmailProvider,
    EmailSuppressionService,
    UnsubscribeTokenService,
    UnsubscribeService,
  ],
  exports: [
    EmailService,
    EmailDeliveryService,
    EmailProviderFactory,
    EmailSuppressionService,
  ],
})
export class EmailModule {}

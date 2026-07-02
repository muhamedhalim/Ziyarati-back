import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailLog } from '../../entities/System/EmailLog';

import { EmailService } from './email.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailProviderFactory } from './providers/email-provider.factory';
import { ResendProvider } from './providers/resend.provider';
import { NoopEmailProvider } from './providers/noop-email.provider';
import { EmailLogController } from './email-log.controller';

/**
 * Email infrastructure. `EmailService` is the single business entry point (no
 * module calls a provider directly); providers sit behind
 * {@link EmailProviderFactory}. Global so any domain (auth, subscriptions,
 * appointments, …) can inject `EmailService` without re-importing. Imported in
 * BOTH the API root (AppModule) and the worker root (WorkerModule) — the worker's
 * EmailProcessor reuses {@link EmailDeliveryService} to deliver queued emails.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([EmailLog])],
  controllers: [EmailLogController],
  providers: [
    EmailService,
    EmailDeliveryService,
    EmailProviderFactory,
    ResendProvider,
    NoopEmailProvider,
  ],
  exports: [EmailService, EmailDeliveryService, EmailProviderFactory],
})
export class EmailModule {}

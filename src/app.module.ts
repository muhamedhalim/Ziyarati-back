import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { typeOrmFactory } from './config/typeorm.config';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';

import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { CsrfGuard } from './modules/auth/guards/csrf.guard';
import { TenantModule } from './modules/tenant/tenant.module';
import { AppointmentModule } from './modules/appointment/appointment.module';
import { StaffModule } from './modules/staff/staff.module';
import { SubscriptionBillingModule } from './modules/subscription-billing/subscription-billing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { AiModule } from './modules/ai/ai.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CrmModule } from './modules/crm/crm.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PlatformModule } from './modules/platform/platform.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { TenantContextModule } from './core/tenant-context/tenant-context.module';
import { SeedModule } from './seed/seed.module';

import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      cache: true,
      validate,
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: typeOrmFactory,
    }),

    TenantContextModule,
    // Background-job producers (BullMQ): registers the queues so any service can
    // enqueue. The HTTP API NEVER runs workers — processors live in WorkerModule.
    QueueModule,
    HealthModule,
    AuthModule,
    TenantModule,
    AppointmentModule,
    StaffModule,
    SubscriptionBillingModule,
    NotificationsModule,
    CampaignsModule,
    WhatsappModule,
    ConversationsModule,
    AiModule,
    PaymentsModule,
    CrmModule,
    AnalyticsModule,
    PlatformModule,
    SchedulingModule,
    SeedModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Runs after authentication; enforces double-submit CSRF on cookie-authed
    // state-changing requests (no-op for safe methods and non-cookie clients).
    {
      provide: APP_GUARD,
      useClass: CsrfGuard,
    },
  ],
})
export class AppModule {}
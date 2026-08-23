import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { AiMemoryModule } from '../ai-memory/ai-memory.module';

import { AiModule } from '../ai/ai.module';
import { AiAttachmentModule } from '../ai-attachment/ai-attachment.module';
import { StorageModule } from '../storage/storage.module';

import { GuestSessionService } from './guest-session.service';
import { GuestChatController } from './guest-chat.controller';
import { GuestAttachmentController } from './attachments/guest-attachment.controller';
import { GuestAttachmentService } from './attachments/guest-attachment.service';
import { GuestAttachmentExtractionService } from './attachments/guest-attachment-extraction.service';

/**
 * Guest (anonymous) AI chat (Feature 1). Reuses `FreeAccessOverrideService`
 * (unmetered discovery tenant) + `AiMemoryService` (guest→patient conversion).
 * Signs guest tokens with the same access secret the gateway verifies — the
 * WebSocket gateway + orchestrator + engine are reused UNCHANGED.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Tenant, AiConversation, AuditLog]),
    SubscriptionBillingModule,
    AiMemoryModule,
    // Chat attachments: the R2 gateway (StorageModule), the Redis staging the
    // redeeming turn reads from (AiAttachmentModule), and AiProviderFactory
    // for the single vision pass that turns an uploaded image into text.
    // AiModule does NOT import this module — the staging service was hoisted
    // into its own module precisely so it would not have to.
    StorageModule,
    AiAttachmentModule,
    AiModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [GuestChatController, GuestAttachmentController],
  providers: [
    GuestSessionService,
    GuestAttachmentService,
    GuestAttachmentExtractionService,
  ],
  exports: [GuestSessionService],
})
export class GuestChatModule {}

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { AiMemoryModule } from '../ai-memory/ai-memory.module';

import { GuestSessionService } from './guest-session.service';
import { GuestChatController } from './guest-chat.controller';

/**
 * Guest (anonymous) AI chat (Feature 1). Reuses `FreeAccessOverrideService`
 * (unmetered discovery tenant) + `AiMemoryService` (guest→patient conversion).
 * Signs guest tokens with the same access secret the gateway verifies — the
 * WebSocket gateway + orchestrator + engine are reused UNCHANGED.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Tenant, AiConversation]),
    SubscriptionBillingModule,
    AiMemoryModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [GuestChatController],
  providers: [GuestSessionService],
  exports: [GuestSessionService],
})
export class GuestChatModule {}

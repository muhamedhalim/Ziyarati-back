import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { AiRealtimeGateway } from './ai-realtime.gateway';
import { WsAuthService } from './ws-auth.service';
import { AgentPresenceService } from './agent-presence.service';
import { HandoverChatService } from './handover-chat.service';
import { HandoverRealtimeListener } from './handover-realtime.listener';
import { HandoverChatController } from './handover-chat.controller';

/**
 * Realtime AI gateway module (Feature 1 + 2, extended for Live Agent Handover).
 * Reuses `AiOrchestratorModule` (the single AI entry point) and verifies the
 * same access JWT as REST. `AuthModule` is imported so `WsAuthService` can
 * reuse `AuthService.buildAuthenticatedUser` (the same roles/permissions
 * lookup the REST JwtStrategy uses) rather than a second, duplicated
 * principal-loading path. The Redis adapter for horizontal scaling is wired in
 * `main.ts` (RedisIoAdapter).
 *
 * Live Agent Handover additions: `AiModule` (HandoverRequestService — the
 * lifecycle state machine + agent-reply persistence, extended not duplicated)
 * and `WhatsappModule` (dispatch an agent's reply to the customer's WhatsApp
 * thread). Neither module imports AiRealtimeModule back, so this stays
 * acyclic — the alternative (importing WhatsappModule into AiModule instead)
 * WOULD cycle, since WhatsappModule already imports AiOrchestratorModule which
 * imports AiModule. `ConversationsModule` (FND-023 — recording the provider
 * message id an agent's WhatsApp send returns, onto the timeline message) is
 * safe to import directly, no forwardRef needed: it imports only
 * StorageModule, so there is no path back to AiRealtimeModule.
 */
@Module({
  imports: [
    AiOrchestratorModule,
    AuthModule,
    AiModule,
    WhatsappModule,
    ConversationsModule,
    // Sockets bypass the HTTP guard chain entirely, so the gateway asks
    // `AccessControlService` the same entitlement question a route would.
    // Acyclic: SubscriptionBillingModule imports only PlatformModule.
    SubscriptionBillingModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [HandoverChatController],
  providers: [
    AiRealtimeGateway,
    WsAuthService,
    AgentPresenceService,
    HandoverChatService,
    HandoverRealtimeListener,
  ],
  exports: [AgentPresenceService],
})
export class AiRealtimeModule {}

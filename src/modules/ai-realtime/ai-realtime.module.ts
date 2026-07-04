import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { AuthModule } from '../auth/auth.module';
import { AiRealtimeGateway } from './ai-realtime.gateway';
import { WsAuthService } from './ws-auth.service';

/**
 * Realtime AI gateway module (Feature 1 + 2). Reuses `AiOrchestratorModule` (the
 * single AI entry point) and verifies the same access JWT as REST. `AuthModule`
 * is imported so `WsAuthService` can reuse `AuthService.buildAuthenticatedUser`
 * (the same roles/permissions lookup the REST JwtStrategy uses) rather than a
 * second, duplicated principal-loading path. The Redis adapter for horizontal
 * scaling is wired in `main.ts` (RedisIoAdapter).
 */
@Module({
  imports: [
    AiOrchestratorModule,
    AuthModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      }),
    }),
  ],
  providers: [AiRealtimeGateway, WsAuthService],
})
export class AiRealtimeModule {}

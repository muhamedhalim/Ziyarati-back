import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../../../common/errors';
import {
  AI_COMPLETION_PROVIDERS,
  AiCompletionProvider,
} from './ai-provider.interface';
import { NoopAiProvider } from './noop-ai.provider';

/**
 * Resolves the AI completion provider for a model (strategy selection). Real
 * providers are injected via the AI_COMPLETION_PROVIDERS token; if none supports
 * the requested model, the no-op provider is used. Single seam through which the
 * execution layer reaches a provider — keeping the domain provider-agnostic.
 *
 * Production guard (FND-035, AD-08): an exact structural mirror of
 * `payment-gateway.factory.ts`'s anti-simulation guard. The noop provider
 * SIMULATES a real AI reply with a canned message, so in production a
 * fall-through to it fails CLOSED instead — a tenant paying for AI gets a loud
 * error, never a silently fake answer.
 */
@Injectable()
export class AiProviderFactory {
  constructor(
    @Inject(AI_COMPLETION_PROVIDERS)
    private readonly providers: AiCompletionProvider[],
    private readonly fallback: NoopAiProvider,
    private readonly config: ConfigService,
  ) {}

  /** Production runtime — dev/test keep the noop path. No new config key: derived from NODE_ENV alone, mirroring `payments.config.ts`'s `paymentsLive`. */
  private get aiLive(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  resolve(model?: string): AiCompletionProvider {
    const provider = this.providers.find((p) => p.supports(model)) ?? this.fallback;

    if (provider === this.fallback && this.aiLive) {
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        message:
          'AI provider is not available: no configured provider supports this request. Contact the platform operator.',
      });
    }
    return provider;
  }
}

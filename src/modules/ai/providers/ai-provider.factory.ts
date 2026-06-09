import { Inject, Injectable } from '@nestjs/common';
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
 */
@Injectable()
export class AiProviderFactory {
  constructor(
    @Inject(AI_COMPLETION_PROVIDERS)
    private readonly providers: AiCompletionProvider[],
    private readonly fallback: NoopAiProvider,
  ) {}

  resolve(model?: string): AiCompletionProvider {
    return this.providers.find((p) => p.supports(model)) ?? this.fallback;
  }
}

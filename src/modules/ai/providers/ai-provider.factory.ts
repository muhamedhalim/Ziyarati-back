import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../../../common/errors';
import { AI_MODEL_NOT_PERMITTED } from '../execution/ai-execution.constants';
import { allowedModelId } from '../routing/ai-model-registry';
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
 *
 * MODEL POLICY GATE. Because this is the ONLY seam through which anything in
 * the codebase reaches a completion provider, it is also where the platform's
 * model allow-list is enforced at dispatch time. Every other gate is about
 * where a model id may be WRITTEN (the agent DTO, the `ai.default_model` enum,
 * env validation) or CHOSEN (`AiModelRouterService`); this one is about whether
 * it may be SENT. A caller that skips routing entirely — as the guest
 * attachment vision pass once did, reading its model straight from an env var —
 * still cannot dispatch a model the platform does not permit.
 */
@Injectable()
export class AiProviderFactory {
  private readonly logger = new Logger('AiProviderFactory');

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

  /**
   * @param model The model to dispatch. Omitted ⇒ "any provider", used by call
   *   sites that let the provider apply its own default — itself allow-listed
   *   (`OPENAI_CHAT_MODEL` is Joi-validated against the registry), so an absent
   *   model cannot be a way around this gate.
   * @throws AppError(SERVICE_UNAVAILABLE) when `model` is outside the registry.
   *   Thrown BEFORE provider selection, in every environment: dropping through
   *   to the noop provider instead would answer a policy violation in dev with
   *   a plausible-looking fake reply.
   */
  resolve(model?: string): AiCompletionProvider {
    if (model !== undefined && !allowedModelId(model)) {
      // The rejected id goes to the log and to internalContext, never to the
      // client — a caller learns that its model was refused, not what the
      // permitted ones are.
      this.logger.error(
        `Refusing to dispatch AI model "${model}": not permitted by platform policy.`,
      );
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        message:
          'The requested AI model is not permitted by platform policy. ' +
          'The request was refused rather than sent to the provider.',
        publicContext: { reason: AI_MODEL_NOT_PERMITTED },
        internalContext: { requestedModel: model },
      });
    }

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

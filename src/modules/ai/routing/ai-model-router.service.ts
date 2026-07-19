import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

export interface ModelRouteInput {
  tenantId: string;
  conversationId: string;
  legacyModel?: string;
  feature: string;
  route: string;
  complexity?: 'STANDARD' | 'HIGH';
}

/** Feature/route based routing only; it never inspects patient prompt content. */
@Injectable()
export class AiModelRouterService {
  constructor(private readonly config: ConfigService) {}

  resolve(input: ModelRouteInput): { model: string | undefined; routed: boolean; reason: string } {
    if (!this.enabled() || !this.inRollout(input)) {
      return { model: input.legacyModel, routed: false, reason: 'legacy_flag' };
    }
    const powerful = input.complexity === 'HIGH'
      || this.csv('AI_POWERFUL_FEATURES').has(input.feature)
      || this.csv('AI_POWERFUL_ROUTES').has(input.route);
    const model = powerful
      ? this.config.get<string>('AI_POWERFUL_MODEL') || input.legacyModel
      : this.config.get<string>('AI_ECONOMY_MODEL') || input.legacyModel;
    return { model, routed: model !== input.legacyModel, reason: powerful ? 'powerful_route' : 'economy_route' };
  }

  private enabled(): boolean {
    return String(this.config.get('AI_MODEL_ROUTING_ENABLED', 'false')) === 'true';
  }

  private inRollout(input: ModelRouteInput): boolean {
    const pct = Math.max(0, Math.min(100, Number(this.config.get('AI_MODEL_ROUTING_ROLLOUT_PERCENT', 0))));
    if (pct >= 100) return true;
    if (pct <= 0) return false;
    const bucket = parseInt(createHash('sha256').update(`${input.tenantId}:${input.conversationId}`).digest('hex').slice(0, 8), 16) % 100;
    return bucket < pct;
  }

  private csv(key: string): Set<string> {
    return new Set(String(this.config.get(key, '')).split(',').map((v) => v.trim()).filter(Boolean));
  }
}

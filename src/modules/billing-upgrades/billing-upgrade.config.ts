import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Rough per-unit provider + infrastructure cost assumptions, in MINOR currency
 * units, fed to the ADVISORY AI cost-estimation service as "provider pricing
 * configuration" — never authoritative on their own (the super admin always
 * sets the real final price). Overridable via env so ops can tune them without
 * a code change; the numbers below are placeholder defaults for a new
 * deployment and should be tuned once real provider invoices are available.
 */
@Injectable()
export class BillingUpgradeConfig {
  constructor(private readonly config: ConfigService) {}

  unitProviderCostMinor(metricOrFeature: string): number {
    return this.envNumber(
      `BILLING_UPGRADE_UNIT_PROVIDER_COST_${metricOrFeature}`,
      this.defaults(metricOrFeature).provider,
    );
  }

  unitInfraCostMinor(metricOrFeature: string): number {
    return this.envNumber(
      `BILLING_UPGRADE_UNIT_INFRA_COST_${metricOrFeature}`,
      this.defaults(metricOrFeature).infra,
    );
  }

  /** Flat markup applied over (provider + infra) cost for the heuristic fallback price. */
  get fallbackMarginMultiplier(): number {
    return this.envNumber('BILLING_UPGRADE_FALLBACK_MARGIN_MULTIPLIER', 1.3);
  }

  private defaults(key: string): { provider: number; infra: number } {
    switch (key) {
      case 'AI_TOKENS':
        return { provider: 2, infra: 1 }; // per 1,000 tokens, minor units
      case 'WHATSAPP_MESSAGES':
        return { provider: 5, infra: 1 }; // per message
      case 'APPOINTMENTS':
        return { provider: 0, infra: 2 }; // per appointment slot / month
      case 'CAMPAIGNS':
        return { provider: 0, infra: 50 }; // per campaign send
      default:
        // Unmapped metric or a feature-enablement request — no per-unit model
        // configured; the AI/heuristic falls back to a flat, low-confidence figure.
        return { provider: 0, infra: 0 };
    }
  }

  private envNumber(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}

import { Injectable } from '@nestjs/common';

import {
  OverageProjection,
  OveragePricingStrategy,
} from './usage-forecast';

/**
 * Default overage pricing: INACTIVE. Overage billing is not live yet, so this
 * reports the overage units but no cost (`projectedCost: null`, `active: false`).
 * It exists so the dashboard architecture is ready — bind a real
 * `OveragePricingStrategy` to the `OVERAGE_PRICING` token to switch on pricing
 * WITHOUT touching any dashboard code. No price is hardcoded anywhere.
 */
@Injectable()
export class NoopOveragePricing implements OveragePricingStrategy {
  readonly active = false;
  readonly currency = 'USD';

  project(_metric: string, overageUnits: number): OverageProjection {
    return {
      overageUnits: Math.max(overageUnits, 0),
      projectedCost: null,
      currency: this.currency,
      active: false,
    };
  }
}

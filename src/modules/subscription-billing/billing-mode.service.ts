import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import {
  BillingMode,
  BILLING_MODE_SETTING_KEY,
  DEFAULT_BILLING_MODE,
} from './platform-billing.constants';

/**
 * Global platform billing mode (Mode A: free / Mode B: paid).
 *
 * Persisted in the existing platform-owned `system_settings` table (key
 * `billing.mode`), so the switch is:
 *   - runtime (no redeploy) — flipping the setting takes effect immediately,
 *   - schema-free (no new table / no DB restructuring),
 *   - non-destructive (no subscription/user state is touched when toggling).
 *
 * Reads are cached briefly: the mode is consulted on every gated request but
 * changes only by a deliberate super-admin action, so a short TTL keeps the hot
 * path off the database without making the switch feel laggy. `set()` refreshes
 * the cache immediately so the operator sees their change at once.
 *
 * Multi-replica note (L7 — docs/CACHING_QUEUES_AUDIT.md): `cached` is a
 * PER-PROCESS field. `set()`'s immediate refresh only applies to the replica
 * that handled the write; every other replica keeps serving the previous
 * mode for up to `CACHE_TTL_MS`. Accepted for the same reason as
 * `SystemSettingService`'s identical pattern: this changes rarely and
 * deliberately, so a bounded 15s cross-replica lag is cheaper than making
 * the hottest gate in the request path (every gated request) pay for a
 * cross-replica-consistent cache.
 *
 * Managed ONLY by the super admin (enforced at the controller via RolesGuard).
 */
@Injectable()
export class BillingModeService {
  private readonly logger = new Logger('BillingModeService');
  private static readonly CACHE_TTL_MS = 15_000;

  private cached?: { mode: BillingMode; at: number };

  constructor(
    @InjectRepository(SystemSetting)
    private readonly settings: Repository<SystemSetting>,
  ) {}

  /** The active global mode (cached). Defaults to FREE when never configured. */
  async get(): Promise<BillingMode> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < BillingModeService.CACHE_TTL_MS) {
      return this.cached.mode;
    }
    const mode = await this.read();
    this.cached = { mode, at: now };
    return mode;
  }

  /** True when paid enforcement is globally active (Mode B). */
  async isPaidMode(): Promise<boolean> {
    return (await this.get()) === BillingMode.PAID;
  }

  /** Super-admin switch. Upserts the setting and refreshes the cache. */
  async set(mode: BillingMode): Promise<{ mode: BillingMode }> {
    let setting = await this.settings.findOne({
      where: { key: BILLING_MODE_SETTING_KEY },
    });
    if (setting) {
      setting.value = { mode };
    } else {
      setting = this.settings.create({
        key: BILLING_MODE_SETTING_KEY,
        value: { mode },
      });
    }
    await this.settings.save(setting);
    this.cached = { mode, at: Date.now() };
    this.logger.log(`Global billing mode set to "${mode}"`);
    return { mode };
  }

  private async read(): Promise<BillingMode> {
    const setting = await this.settings.findOne({
      where: { key: BILLING_MODE_SETTING_KEY },
    });
    const raw = (setting?.value as { mode?: string } | undefined)?.mode;
    return raw === BillingMode.PAID
      ? BillingMode.PAID
      : raw === BillingMode.FREE
        ? BillingMode.FREE
        : DEFAULT_BILLING_MODE;
  }
}

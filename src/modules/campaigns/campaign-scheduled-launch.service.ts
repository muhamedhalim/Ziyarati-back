import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { CampaignExecutionService } from './campaign-execution.service';

/** A scheduled campaign this far overdue is left for a person to decide about. */
const MAX_OVERDUE_MS = 24 * 3_600_000;
const BATCH = 50;

export interface ScheduledLaunchOptions {
  /** Renews the sweep's lock; `false` means it was lost and the run must stop. */
  keepAlive?: () => Promise<boolean>;
}

export interface ScheduledLaunchResult {
  due: number;
  launched: number;
  failed: number;
}

/**
 * Launches SCHEDULED campaigns when their time arrives.
 *
 * Until now "schedule" only saved a date: nothing ever acted on it, so a clinic
 * that scheduled a promotion for Friday morning got nothing on Friday. This is the
 * missing clock.
 *
 * Deliberately narrow:
 *  - It only launches for a clinic that has the "scheduled promotional campaign"
 *    rule ENABLED. Switching that rule on is the owner's explicit consent to
 *    automatic launching; without it a scheduled campaign still waits for a manual
 *    launch exactly as before.
 *  - It calls the SAME `CampaignExecutionService.launch` a person's click does, so
 *    every existing protection stays in force: the sendable-account and
 *    approved-template preflight, consent and opt-out, caps, throttling and quota.
 *  - Once launched the campaign is ACTIVE, so a repeat sweep, or a second worker
 *    racing this one, cannot launch it twice (the lifecycle transition refuses).
 *  - A campaign more than 24h overdue (the system was down, say) is left alone
 *    rather than surprising patients a day late.
 */
@Injectable()
export class CampaignScheduledLaunchService {
  private readonly logger = new Logger(CampaignScheduledLaunchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly execution: CampaignExecutionService,
    private readonly ctx: TenantContextService,
  ) {}

  async sweep(
    now: Date = new Date(),
    opts: ScheduledLaunchOptions = {},
  ): Promise<ScheduledLaunchResult> {
    const due: Array<{ id: string; tenantId: string; ruleId: string }> =
      await this.dataSource.query(
        `SELECT c.id, c."tenantId", r.id AS "ruleId"
         FROM campaigns c
         JOIN notification_rules r
           ON r."tenantId" = c."tenantId" AND r.rule_key = 'scheduled_promotion' AND r.is_active = true
         JOIN tenants t ON t.id = c."tenantId" AND t.is_active = true AND t.deleted_at IS NULL
        WHERE c.lifecycle = 'SCHEDULED' AND c.deleted_at IS NULL
          AND c.scheduled_at <= $1 AND c.scheduled_at > $2
        ORDER BY c.scheduled_at ASC
        LIMIT $3`,
        [now, new Date(now.getTime() - MAX_OVERDUE_MS), BATCH],
      );

    const result: ScheduledLaunchResult = {
      due: due.length,
      launched: 0,
      failed: 0,
    };
    for (const campaign of due) {
      if (opts.keepAlive && !(await opts.keepAlive())) {
        this.logger.warn(
          'scheduled-launch sweep lost its lock — aborting this run',
        );
        break;
      }
      try {
        await this.ctx.run(() => {
          this.ctx.setPrincipal({
            id: 'system',
            tenantId: campaign.tenantId,
            email: null,
            roles: [],
            permissions: [],
          });
          return this.execution.launch(campaign.tenantId, campaign.id, {});
        });
        result.launched += 1;
        await this.touchRule(campaign.ruleId, null);
      } catch (err) {
        // Stays SCHEDULED: a person sees it on the Campaigns tab and the reason
        // on the rule card. Never logs the campaign's content or audience.
        result.failed += 1;
        const message = (err as Error)?.message ?? 'launch failed';
        this.logger.warn(
          `scheduled campaign ${campaign.id} was not launched: ${message}`,
        );
        await this.touchRule(campaign.ruleId, message);
      }
    }
    return result;
  }

  private async touchRule(ruleId: string, error: string | null): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE notification_rules SET last_run_at = now(), last_error = $2 WHERE id = $1`,
        [ruleId, error ? error.slice(0, 200) : null],
      );
    } catch (err) {
      this.logger.warn(
        `could not record run of rule ${ruleId}: ${(err as Error)?.message}`,
      );
    }
  }
}

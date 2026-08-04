import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { CampaignExecution } from '../../entities/enums';
import { EDITABLE_RUN_EXECUTIONS } from './campaign.constants';

/**
 * Owns CampaignRun resolution + state. A campaign has many runs over its life;
 * the "current" run is the latest one that is not in a terminal execution state.
 * Enrollment (add/remove recipients) targets the current run; launch transitions
 * it; retry creates a fresh run.
 *
 * Methods accept an optional EntityManager so callers can run them inside the
 * same transaction as a state change (e.g. launch + outbox).
 */
@Injectable()
export class CampaignRunService {
  constructor(
    @InjectRepository(CampaignRun)
    private readonly runs: Repository<CampaignRun>,
  ) {}

  private repo(mgr?: EntityManager): Repository<CampaignRun> {
    return mgr ? mgr.getRepository(CampaignRun) : this.runs;
  }

  /** Most recent run for a campaign (any state), or null. */
  async latest(
    tenantId: string,
    campaignId: string,
    mgr?: EntityManager,
  ): Promise<CampaignRun | null> {
    return this.repo(mgr).findOne({
      where: { tenant: { id: tenantId }, campaign: { id: campaignId } },
      order: { created_at: 'DESC' },
    });
  }

  /** Creates a fresh IDLE run. */
  async create(
    tenantId: string,
    campaignId: string,
    mgr?: EntityManager,
  ): Promise<CampaignRun> {
    const repo = this.repo(mgr);
    const run = repo.create({
      tenant: { id: tenantId } as Tenant,
      campaign: { id: campaignId } as Campaign,
      execution: CampaignExecution.IDLE,
      idempotency_key: randomUUID(),
    });
    return repo.save(run);
  }

  /**
   * The run that enrollment / launch should target: the latest run if it is
   * still editable (IDLE, or DRAINING — see below), otherwise a new IDLE run.
   * Terminal or actively-claiming (ENQUEUEING/PROCESSING) runs are never
   * mutated.
   *
   * FND-019: DRAINING is deliberately editable. A DRAINING run is paused —
   * not claiming new work, but not abandoning its still-PENDING recipients
   * either (see campaign-dispatch.service.ts's PAUSE_RECHECK_MS defer
   * branch). Forking a fresh run for recipients added mid-pause (the
   * pre-fix behavior) orphans them: `pause()`/`resume()` resolve "the run in
   * play" via `latest()`, so once a newer IDLE fork exists, resume() can
   * never see the original DRAINING run again — it stays DRAINING forever
   * (its in-flight delayed jobs re-defer every 30s, permanently), while the
   * fork is never launched by any code path (the campaign is already ACTIVE
   * after resume(), and launch() refuses a same-to-same lifecycle
   * transition). Keeping everything on ONE run while paused means resume()'s
   * existing re-fanout (cursor=null) naturally picks up every still-PENDING
   * recipient — old and newly-added alike — exactly once.
   */
  async currentEditable(
    tenantId: string,
    campaignId: string,
    mgr?: EntityManager,
  ): Promise<CampaignRun> {
    const latest = await this.latest(tenantId, campaignId, mgr);
    if (latest && EDITABLE_RUN_EXECUTIONS.includes(latest.execution)) return latest;
    return this.create(tenantId, campaignId, mgr);
  }

  /**
   * Atomically bumps a run's materialized `total_recipients`/`queued`
   * counters (FND-019). Needed only when appending to an ALREADY-launched
   * run (DRAINING) — `launch()` always recomputes both from a fresh COUNT
   * query, so a bump on a not-yet-launched IDLE run is simply overwritten
   * there, harmlessly. Keeps `campaign-analytics.service.ts`'s O(1) summary
   * reads accurate immediately, without waiting for resume()'s re-fanout.
   */
  async incrementCounters(
    runId: string,
    added: number,
    mgr?: EntityManager,
  ): Promise<void> {
    if (added <= 0) return;
    const repo = this.repo(mgr);
    await repo.increment({ id: runId }, 'total_recipients', added);
    await repo.increment({ id: runId }, 'queued', added);
  }
}

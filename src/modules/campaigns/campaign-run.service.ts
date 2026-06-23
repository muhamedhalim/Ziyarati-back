import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { CampaignExecution } from '../../entities/enums';

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
   * still editable (IDLE), otherwise a new IDLE run. Terminal or in-flight runs
   * are never mutated.
   */
  async currentEditable(
    tenantId: string,
    campaignId: string,
    mgr?: EntityManager,
  ): Promise<CampaignRun> {
    const latest = await this.latest(tenantId, campaignId, mgr);
    if (latest && latest.execution === CampaignExecution.IDLE) return latest;
    return this.create(tenantId, campaignId, mgr);
  }
}

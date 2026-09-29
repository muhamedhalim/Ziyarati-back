import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { IntegrationImportJob } from '../../../entities/Integration/IntegrationImportJob';
import { IntegrationSyncJob } from '../../../entities/Integration/IntegrationSyncJob';
import { AppError, ErrorCode } from '../../../common/errors';
import { TenantRateLimiterService } from '../../../queue/tenant-rate-limiter.service';

import {
  ACTIVE_JOB_STATUSES,
  ADMISSION_LIMITS,
  ADMISSION_OP,
  AdmissionOp,
  MAX_CONCURRENT_IMPORT_JOBS,
  MAX_CONCURRENT_SYNC_JOBS,
} from '../integration-platform.constants';

export interface AdmissionContext {
  tenantId: string;
  /** API key id when the caller is an external M2M client. */
  keyId?: string | null;
  connectionId?: string | null;
}

/**
 * Admission control for SENSITIVE integration operations (Phase 4).
 *
 * Deliberately SEPARATE from the read-only API's limiter policy. `ApiKeyAuthGuard`
 * fails OPEN when Redis is down — a justified choice for read traffic, but it must
 * NEVER be inherited by a write, import, sync, or inbound webhook. Every operation
 * routed through this service is admitted only if it can be *checked*:
 *
 *   Redis reachable   → token-bucket per key / per tenant / per connection.
 *   Redis unavailable → FAIL CLOSED with a retryable 503, because admitting an
 *                       unbounded number of unchecked mutations is strictly worse
 *                       than making the caller retry. The operation is rejected
 *                       BEFORE anything is persisted or enqueued, so nothing is
 *                       half-accepted and nothing silently disappears.
 *
 * Concurrency caps (max simultaneous import/sync jobs) are enforced against the
 * DATABASE, not Redis, so they remain correct during a Redis outage and cannot be
 * bypassed by a racing client.
 */
@Injectable()
export class IntegrationAdmissionService {
  private readonly logger = new Logger(IntegrationAdmissionService.name);

  constructor(
    private readonly rateLimiter: TenantRateLimiterService,
    private readonly config: ConfigService,
    @InjectRepository(IntegrationImportJob) private readonly importJobs: Repository<IntegrationImportJob>,
    @InjectRepository(IntegrationSyncJob) private readonly syncJobs: Repository<IntegrationSyncJob>,
  ) {}

  /**
   * Enforce the per-scope rate limits for one operation class. Throws
   * RATE_LIMITED (429) when over budget, or SERVICE_UNAVAILABLE (503, retryable)
   * when the limiter itself cannot be consulted. Never fails open.
   */
  async admit(op: AdmissionOp, ctx: AdmissionContext): Promise<void> {
    const limits = ADMISSION_LIMITS[op];
    const scopes: Array<{ bucket: string; ratePerMinute: number }> = [];

    if (limits.perKeyPerMin && ctx.keyId) {
      scopes.push({ bucket: `int:${op}:key:${ctx.keyId}`, ratePerMinute: this.limit(op, 'KEY', limits.perKeyPerMin) });
    }
    scopes.push({ bucket: `int:${op}:tenant`, ratePerMinute: this.limit(op, 'TENANT', limits.perTenantPerMin) });
    if (limits.perConnectionPerMin && ctx.connectionId) {
      scopes.push({
        bucket: `int:${op}:conn:${ctx.connectionId}`,
        ratePerMinute: this.limit(op, 'CONNECTION', limits.perConnectionPerMin),
      });
    }

    for (const scope of scopes) {
      let decision: Awaited<ReturnType<TenantRateLimiterService['consume']>>;
      try {
        decision = await this.rateLimiter.consume(ctx.tenantId, scope.bucket, {
          ratePerMinute: scope.ratePerMinute,
        });
      } catch (err) {
        // FAIL CLOSED — see class docstring. Rejected before any persistence.
        this.logger.error(
          `admission limiter unavailable for ${op} (tenant=${ctx.tenantId}) — rejecting: ${(err as Error)?.message}`,
        );
        throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
          message: 'Integration admission control is temporarily unavailable — retry shortly',
          publicContext: { retryAfterMs: 5_000 },
        });
      }
      if (!decision.allowed) {
        throw new AppError(ErrorCode.RATE_LIMITED, {
          message: `Rate limit exceeded for ${op} — slow down and retry later`,
          // The limiter knows when a token frees up; the filter turns this into
          // a `Retry-After` header so a client can back off precisely.
          publicContext:
            decision.reason === 'RATE' ? { retryAfterMs: decision.retryAfterMs } : undefined,
        });
      }
    }
  }

  /** Reject a new import job when the tenant already has too many in flight. */
  async assertImportConcurrency(tenantId: string): Promise<void> {
    const max = this.num('INTEGRATION_MAX_CONCURRENT_IMPORTS', MAX_CONCURRENT_IMPORT_JOBS);
    const active = await this.importJobs.count({
      where: { tenant: { id: tenantId }, status: In(ACTIVE_JOB_STATUSES) },
    });
    if (active >= max) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: `Too many import jobs already running (max ${max}) — wait for one to finish`,
      });
    }
  }

  /** Reject a new sync run when the tenant already has too many in flight. */
  async assertSyncConcurrency(tenantId: string): Promise<void> {
    const max = this.num('INTEGRATION_MAX_CONCURRENT_SYNCS', MAX_CONCURRENT_SYNC_JOBS);
    const active = await this.syncJobs.count({
      where: { tenant: { id: tenantId }, status: In(ACTIVE_JOB_STATUSES) },
    });
    if (active >= max) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: `Too many sync runs already active (max ${max}) — wait for one to finish`,
      });
    }
  }

  /**
   * Reject an oversized payload BEFORE it is staged/enqueued. Measured on the
   * serialized form so a deeply nested body cannot slip past a field count.
   */
  assertPayloadSize(payload: unknown, maxBytes: number, what = 'payload'): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `The ${what} could not be processed` });
    }
    if (bytes > maxBytes) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `The ${what} exceeds the maximum size of ${Math.floor(maxBytes / 1024)} KB`,
      });
    }
  }

  // ── Config helpers ────────────────────────────────────────────────────────

  /** Env override: `INTEGRATION_RL_<OP>_<SCOPE>` (op dots → underscores). */
  private limit(op: AdmissionOp, scope: 'KEY' | 'TENANT' | 'CONNECTION', fallback: number): number {
    const key = `INTEGRATION_RL_${op.toUpperCase().replace(/\./g, '_')}_${scope}`;
    return this.num(key, fallback);
  }

  private num(key: string, fallback: number): number {
    const v = Number(this.config.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }
}

export { ADMISSION_OP };

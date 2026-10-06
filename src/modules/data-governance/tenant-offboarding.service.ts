import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import {
  DeletionEvidence,
  type DeletionReport,
  type DeletionStatus,
  type DeletionStoreResult,
} from '../../entities/Governance/DeletionEvidence';
import { StorageService } from '../storage/storage.service';
import { loadPlannerSchema } from './tenant-offboarding.catalog';
import {
  NOT_REACHED,
  buildTenantDeletionPlan,
  type TenantDeletionStep,
} from './tenant-offboarding.plan';

export interface OffboardOptions {
  /** Must equal the tenant id — a deliberate second keystroke for an irreversible act. */
  confirm: string;
  /**
   * Also delete the clinic's payment-LEDGER rows. The ledger (`transactions`) is
   * append-only by a database trigger because it is an accounting record; whether
   * it may be erased when a clinic leaves is a legal decision (plan L12). Without
   * this flag a clinic that has ledger rows is REFUSED, not partially deleted.
   */
  purgeLedger?: boolean;
  /** Executes every statement and reports exact counts, then rolls back. Nothing persists. */
  dryRun?: boolean;
  performedByUserId?: string;
}

export interface OffboardResult {
  dryRun: boolean;
  status: DeletionStatus;
  evidenceId?: string;
  report: DeletionReport;
}

/** The immutable payment ledger and the trigger that enforces it (migration PaymentsPhase3a). */
export const LEDGER_TABLE = 'transactions';
export const LEDGER_TRIGGER = 'transactions_no_mutate';

/** What this operation cannot reach, reported in every evidence record. */
const GAPS: ReadonlyArray<{ target: string; reason: string }> = [
  {
    target: 'database backups and point-in-time recovery',
    reason:
      "The tenant's rows persist in backups until the backup retention window passes. Backups are not edited.",
  },
  {
    target: 'queue payloads in Redis (queued or failed jobs) and Redis keys',
    reason:
      "Jobs and cache keys are not indexed by tenant; those holding this tenant's data expire or fail on their own (failed PII jobs: 6 h). Not scanned or deleted here.",
  },
  {
    target: 'application logs and CloudWatch',
    reason:
      'Logs are scrubbed at write time; retained logs age out under the log retention period.',
  },
  {
    target: 'processor-side copies (OpenAI, Meta, Tap, email provider)',
    reason:
      'Copies held by third parties are outside this system; asking each to delete is a separate, manual step (see the subprocessor register).',
  },
  {
    target: 'data_subject_requests and deletion_evidence for this tenant',
    reason:
      'Retained on purpose: accountability records that hold ids and counts only and must outlive the tenant.',
  },
  ...NOT_REACHED.map((n) => ({ target: n.table, reason: n.reason })),
];

/**
 * Deletes ONE tenant (clinic) and everything it owns (residency plan P11).
 *
 * Irreversible, so every guard fails closed:
 *  - the caller must repeat the tenant id (`confirm`);
 *  - the tenant must already be INACTIVE (suspended) — a live clinic is refused;
 *  - the database work is ONE transaction, so any failure leaves the clinic whole;
 *  - a dry run is the real run rolled back, so its counts are exact;
 *  - stored objects (every version, under `<tenantId>/`) are purged only AFTER the
 *    database commit, and a failure there is reported as PARTIAL.
 *
 * What gets deleted is computed from the schema by `buildTenantDeletionPlan`, and
 * a foreign key that the plan did not anticipate fails the transaction rather
 * than leaving the clinic half-deleted.
 *
 * Exposed through a CLI (`src/tenant-offboard.ts`), not an HTTP route: erasing a
 * clinic is an operator action, and a route would add an authorization surface
 * for something that should never be one click away.
 */
@Injectable()
export class TenantOffboardingService {
  private readonly logger = new Logger(TenantOffboardingService.name);

  /** The plan to execute. A seam for the real-database test, which swaps in a failing step. */
  protected plan?: TenantDeletionStep[];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  /**
   * Built from the DATABASE catalog on every call that needs it — a foreign key a
   * migration created but no entity declares still blocks a delete (see
   * `tenant-offboarding.catalog.ts`). Not cached: the schema can change between runs.
   */
  async getPlan(): Promise<TenantDeletionStep[]> {
    return (
      this.plan ??
      buildTenantDeletionPlan(await loadPlannerSchema(this.dataSource))
    );
  }

  async offboard(
    tenantId: string,
    options: OffboardOptions,
  ): Promise<OffboardResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        tenantId,
      )
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'A valid tenant id is required.',
      });
    }
    if (options.confirm !== tenantId) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message:
          'Confirmation does not match the tenant id; nothing was deleted.',
      });
    }

    const dryRun = options.dryRun === true;
    const startedAt = new Date();
    const stores: DeletionStoreResult[] = [];
    const plan = await this.getPlan();

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      const tenant: Array<{ is_active: boolean }> = await qr.query(
        `SELECT "is_active" FROM "tenants" WHERE "id" = $1`,
        [tenantId],
      );
      if (tenant.length === 0) {
        throw new AppError(ErrorCode.TENANT_NOT_FOUND, {
          message: 'Tenant not found.',
        });
      }
      if (tenant[0].is_active) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'This clinic is still active. Suspend it first; a live clinic is never deleted.',
        });
      }

      // The ledger is immutable. Decide BEFORE deleting anything, so a refusal leaves the clinic whole.
      const ledgerStep = plan.find((s) => s.table === LEDGER_TABLE);
      let ledgerRows = 0;
      if (ledgerStep) {
        const rows: Array<{ n: number }> = await qr.query(
          `SELECT count(*)::int AS n FROM "${LEDGER_TABLE}" WHERE ${ledgerStep.predicate.replace(/:tenant\b/g, '$1')}`,
          [tenantId],
        );
        ledgerRows = Number(rows[0]?.n ?? 0);
        if (ledgerRows > 0 && !options.purgeLedger) {
          throw new AppError(ErrorCode.CONFLICT, {
            message:
              `This clinic has ${ledgerRows} row(s) in the immutable payment ledger ("${LEDGER_TABLE}"). The ledger is an append-only ` +
              'accounting record and this operation will not remove it by default. Nothing was deleted. If counsel confirms it may be ' +
              'erased, repeat with the explicit ledger-purge option.',
          });
        }
        if (ledgerRows > 0) {
          const trig: unknown[] = await qr.query(
            `SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass AND NOT tgisinternal`,
            [LEDGER_TRIGGER, LEDGER_TABLE],
          );
          // Not finding the guard means the schema is not what this code was written against.
          if (trig.length === 0) {
            throw new AppError(ErrorCode.INTERNAL_ERROR, {
              message: `Expected ledger trigger "${LEDGER_TRIGGER}" was not found; refusing to proceed.`,
            });
          }
        }
      }

      await qr.startTransaction();
      try {
        // Fail rather than queue behind a long lock held by live traffic.
        await qr.query(`SET LOCAL lock_timeout = '30s'`);
        const purging = ledgerRows > 0 && options.purgeLedger === true;
        // Transactional DDL: rolled back with everything else on failure, and re-enabled
        // below BEFORE the commit so the guard is never left off. The lock it takes keeps
        // concurrent ledger writes out for the duration; the delete itself stays tenant-scoped.
        if (purging)
          await qr.query(
            `ALTER TABLE "${LEDGER_TABLE}" DISABLE TRIGGER "${LEDGER_TRIGGER}"`,
          );
        for (const step of plan) {
          const result = (await qr.query(
            `DELETE FROM "${step.table}" WHERE ${step.predicate.replace(/:tenant\b/g, '$1')}`,
            [tenantId],
            true,
          )) as {
            affected?: number;
          };
          stores.push({
            store: 'database',
            target: step.table,
            action: 'deleted',
            affected: result.affected ?? 0,
          });
        }
        if (purging)
          await qr.query(
            `ALTER TABLE "${LEDGER_TABLE}" ENABLE TRIGGER "${LEDGER_TRIGGER}"`,
          );
        if (dryRun) await qr.rollbackTransaction();
        else await qr.commitTransaction();
      } catch (err) {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        throw err;
      }
    } finally {
      await qr.release();
    }

    let failed = false;
    if (dryRun) {
      stores.push({
        store: 'storage',
        target: `${tenantId}/ (all objects, all versions)`,
        action: 'retained',
        affected: 0,
        reason: 'Dry run — not purged.',
      });
    } else {
      try {
        const { versionsRemoved } =
          await this.storage.purgeTenantPrefix(tenantId);
        stores.push({
          store: 'storage',
          target: `${tenantId}/ (all objects, all versions)`,
          action: 'deleted',
          affected: versionsRemoved,
        });
      } catch (err) {
        failed = true;
        stores.push({
          store: 'storage',
          target: `${tenantId}/`,
          action: 'failed',
          affected: 0,
          reason: `Storage purge failed (${(err as Error)?.name || 'Error'}); the database is already clean. Re-run the purge.`,
        });
      }
    }
    for (const gap of GAPS)
      stores.push({
        store: 'not_covered',
        target: gap.target,
        action: 'not_covered',
        affected: 0,
        reason: gap.reason,
      });

    const report: DeletionReport = {
      stores,
      options: { dryRun, purgeLedger: options.purgeLedger === true },
    };
    const status: DeletionStatus = failed ? 'PARTIAL' : 'COMPLETED';
    if (dryRun) return { dryRun: true, status, report };

    const repo = this.dataSource.getRepository(DeletionEvidence);
    try {
      const evidence = await repo.save(
        repo.create({
          scope: 'TENANT',
          tenant_id: tenantId,
          subject_id: null,
          request_id: null,
          performed_by_user_id: options.performedByUserId ?? null,
          status,
          report,
          started_at: startedAt,
          completed_at: new Date(),
        }),
      );
      return { dryRun: false, status, evidenceId: evidence.id, report };
    } catch (err) {
      // The clinic is already gone and the report holds no personal data, so it is
      // safe to log in full: it is the only copy of the proof.
      this.logger.error(
        `Tenant ${tenantId} deleted but its evidence record could not be saved: ${(err as Error)?.message}. Report: ${JSON.stringify(report)}`,
      );
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message:
          'The tenant was deleted but its evidence record could not be saved. See the application log.',
      });
    }
  }
}

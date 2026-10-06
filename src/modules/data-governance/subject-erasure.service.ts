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
import {
  ERASURE_STEPS,
  KNOWN_GAPS,
  countStatementFor,
  statementFor,
  type ErasureParams,
  type ErasureStep,
} from './subject-erasure.registry';

export type ClinicalChoice = 'retain' | 'erase';

export interface EraseOptions {
  /**
   * REQUIRED, no default. Whether health / clinical content is erased or kept is
   * a legal decision the operator makes per request (plan L12); the choice is
   * recorded in the evidence.
   */
  clinical: ClinicalChoice;
  /** Executes every statement and reports the counts, then rolls back. Nothing persists. */
  dryRun?: boolean;
  requestId?: string;
  performedByUserId?: string;
}

export interface EraseResult {
  dryRun: boolean;
  status: DeletionStatus;
  evidenceId?: string;
  report: DeletionReport;
}

const ACTION_LABEL = {
  delete: 'deleted',
  scrub: 'scrubbed',
  anonymise: 'anonymised',
  retain: 'retained',
} as const;

/** Phone / WhatsApp-id digits are matched inside raw webhook JSON; shorter than this would over-match. */
const MIN_TERM_LENGTH = 7;

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Erases ONE patient inside a tenant (residency plan P11). Executes the plan in
 * `subject-erasure.registry.ts` in a single transaction and returns / persists
 * an evidence report.
 *
 *  - ATOMIC for the database: any failure rolls everything back.
 *  - DRY RUN is the real thing rolled back, so the counts are exact.
 *  - STORAGE objects cannot be rolled back, so they are removed AFTER the commit
 *    (every version — see `StorageService.purgeObject`), and a failure there is
 *    reported as PARTIAL rather than hidden.
 *  - The evidence record holds counts and table names only, never a value.
 */
@Injectable()
export class SubjectErasureService {
  private readonly logger = new Logger(SubjectErasureService.name);

  /** The plan to execute. A seam for the real-database test, which swaps in a failing step. */
  protected steps: readonly ErasureStep[] = ERASURE_STEPS;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  async erase(
    tenantId: string,
    customerId: string,
    options: EraseOptions,
  ): Promise<EraseResult> {
    if (options.clinical !== 'retain' && options.clinical !== 'erase') {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message:
          'Choose whether clinical records are retained or erased; there is no default.',
      });
    }
    const dryRun = options.dryRun === true;
    const startedAt = new Date();
    const stores: DeletionStoreResult[] = [];
    let storageKeys: string[] = [];

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      const found: Array<{
        phone: string | null;
        whatsapp_id: string | null;
        email: string | null;
      }> = await qr.query(
        `SELECT "phone", "whatsapp_id", "email" FROM "customers" WHERE "id" = $1 AND "tenantId" = $2`,
        [customerId, tenantId],
      );
      if (found.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Customer not found in this clinic.',
        });
      }
      const c = found[0];
      const terms = [c.phone, c.whatsapp_id]
        .filter(
          (t): t is string =>
            !!t && t.replace(/\s/g, '').length >= MIN_TERM_LENGTH,
        )
        .map((t) => likePattern(t.trim()));
      const values: ErasureParams = {
        tenant: tenantId,
        customer: customerId,
        terms,
        emails: c.email ? [c.email.trim().toLowerCase()] : [],
      };

      await qr.startTransaction();
      try {
        if (options.clinical === 'erase') {
          // Read BEFORE the rows are deleted: the keys live only in them.
          const files: Array<{
            storage_key: string | null;
            file_url: string | null;
          }> = await qr.query(
            `SELECT "storage_key", "file_url" FROM "customer_files" WHERE "customerId" = $1 AND "tenantId" = $2`,
            [customerId, tenantId],
          );
          storageKeys = files
            .map((f) => f.storage_key ?? f.file_url ?? '')
            // Only objects under this tenant's prefix are ours to purge; a legacy
            // external URL in `file_url` is not a key and is left alone.
            .filter((k) => k.startsWith(`${tenantId}/`));
        }

        for (const step of this.steps) {
          const keepRecords =
            step.group === 'records' && options.clinical === 'retain';
          if (keepRecords || step.action === 'retain') {
            const count = countStatementFor(step, values);
            const rows: Array<{ n: number }> = await qr.query(
              count.text,
              count.params,
            );
            stores.push({
              store: 'database',
              target: step.id,
              action: 'retained',
              affected: Number(rows[0]?.n ?? 0),
              reason: step.reason,
            });
            continue;
          }
          const stmt = statementFor(step, values);
          const result = (await qr.query(stmt.text, stmt.params, true)) as {
            affected?: number;
            records?: unknown[];
          };
          stores.push({
            store: 'database',
            target: step.id,
            action: ACTION_LABEL[step.action],
            affected: result.affected ?? result.records?.length ?? 0,
          });
        }

        if (dryRun) await qr.rollbackTransaction();
        else await qr.commitTransaction();
      } catch (err) {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        throw err;
      }
    } finally {
      await qr.release();
    }

    // Storage cannot be rolled back, so it only happens once the database has
    // committed — and never in a dry run.
    let failed = false;
    if (storageKeys.length > 0) {
      if (dryRun) {
        stores.push({
          store: 'storage',
          target: 'customer_files objects',
          action: 'retained',
          affected: storageKeys.length,
          reason: 'Dry run — not purged.',
        });
      } else {
        let removed = 0;
        let failures = 0;
        let firstError = '';
        for (const key of storageKeys) {
          try {
            removed += (await this.storage.purgeObject(key, tenantId))
              .versionsRemoved;
          } catch (err) {
            failures += 1;
            firstError ||= (err as Error)?.name || 'Error';
          }
        }
        stores.push({
          store: 'storage',
          target: 'customer_files objects (all versions)',
          action: 'deleted',
          affected: removed,
        });
        if (failures > 0) {
          failed = true;
          stores.push({
            store: 'storage',
            target: 'customer_files objects',
            action: 'failed',
            affected: failures,
            reason: `${failures} object(s) could not be purged (${firstError}); retry the purge — the database rows are already gone.`,
          });
        }
      }
    }

    for (const gap of KNOWN_GAPS) {
      stores.push({
        store: 'not_covered',
        target: gap.target,
        action: 'not_covered',
        affected: 0,
        reason: gap.reason,
      });
    }

    const report: DeletionReport = {
      stores,
      options: { clinical: options.clinical },
    };
    const status: DeletionStatus = failed ? 'PARTIAL' : 'COMPLETED';

    if (dryRun) return { dryRun: true, status, report };

    const evidence = await this.persistEvidence({
      tenantId,
      customerId,
      status,
      report,
      startedAt,
      requestId: options.requestId,
      userId: options.performedByUserId,
    });
    return { dryRun: false, status, evidenceId: evidence.id, report };
  }

  private async persistEvidence(args: {
    tenantId: string;
    customerId: string;
    status: DeletionStatus;
    report: DeletionReport;
    startedAt: Date;
    requestId?: string;
    userId?: string;
  }): Promise<DeletionEvidence> {
    const repo = this.dataSource.getRepository(DeletionEvidence);
    try {
      return await repo.save(
        repo.create({
          scope: 'SUBJECT',
          tenant_id: args.tenantId,
          subject_id: args.customerId,
          request_id: args.requestId ?? null,
          performed_by_user_id: args.userId ?? null,
          status: args.status,
          report: args.report,
          started_at: args.startedAt,
          completed_at: new Date(),
        }),
      );
    } catch (err) {
      // The data is already gone. The report holds no personal data, so it is
      // safe to log in full: it is the only copy of the proof.
      this.logger.error(
        `Deletion committed but its evidence record could not be saved (tenant=${args.tenantId}, subject=${args.customerId}): ` +
          `${(err as Error)?.message}. Report: ${JSON.stringify(args.report)}`,
      );
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message:
          'The deletion completed but its evidence record could not be saved. Contact support with the request id.',
      });
    }
  }
}

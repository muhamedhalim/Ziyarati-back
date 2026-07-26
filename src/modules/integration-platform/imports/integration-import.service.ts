import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';

import { BatchImportDto } from '../dto/batch-import.dto';
import {
  IntegrationResource,
  MAX_SYNC_IMPORT_BATCH,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationUpsertService, UpsertActor } from '../write/integration-upsert.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';

export interface ImportSummary {
  connectionId: string;
  resourceType: IntegrationResource;
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  conflicted: number;
  failed: number;
  duplicatesInBatch: number;
  /** Per-record results (safe: ids + outcome + safe error only). */
  results: Array<{
    externalId: string;
    outcome: string;
    internalId: string | null;
    changedFields?: string[];
    error?: string;
  }>;
}

/**
 * Bounded, SYNCHRONOUS batch import for one resource + connection (Phase 3).
 * Reuses the single-record write pipeline (IntegrationUpsertService) so there is
 * exactly ONE mutation path — no second implementation. Partial success is the
 * default; a per-record failure never aborts the batch. Duplicate external ids
 * WITHIN the same batch are detected and skipped (processed once).
 *
 * Large/async imports (queue-based) are a later phase; `atomic` mode likewise
 * requires transactional domain-service support and is explicitly rejected here
 * rather than silently degraded to partial success.
 */
@Injectable()
export class IntegrationImportService {
  constructor(
    private readonly upsert: IntegrationUpsertService,
    private readonly connections: IntegrationConnectionService,
    private readonly audit: IntegrationAuditService,
  ) {}

  async import(
    tenantId: string,
    resource: IntegrationResource,
    dto: BatchImportDto,
    actor: UpsertActor,
  ): Promise<ImportSummary> {
    if (!this.upsert.supports(resource)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Import is not yet supported for resource "${resource}"`,
      });
    }
    if (dto.atomic) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Atomic import mode is not yet available; use partial (default) mode',
      });
    }
    if (dto.records.length > MAX_SYNC_IMPORT_BATCH) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Batch exceeds the maximum of ${MAX_SYNC_IMPORT_BATCH} records`,
      });
    }

    const connection = await this.connections.requireActive(tenantId, dto.connectionId);
    this.connections.assertResourceEnabled(connection, resource);
    const policy = this.connections.conflictPolicyOf(connection);
    const dryRun = !!dto.dryRun;

    const summary: ImportSummary = {
      connectionId: dto.connectionId,
      resourceType: resource,
      dryRun,
      total: dto.records.length,
      created: 0,
      updated: 0,
      linked: 0,
      skipped: 0,
      conflicted: 0,
      failed: 0,
      duplicatesInBatch: 0,
      results: [],
    };

    const seen = new Set<string>();
    for (const record of dto.records) {
      if (seen.has(record.externalId)) {
        summary.duplicatesInBatch += 1;
        summary.skipped += 1;
        summary.results.push({
          externalId: record.externalId,
          outcome: UPSERT_OUTCOME.SKIPPED,
          internalId: null,
          error: 'Duplicate external id within the same batch',
        });
        continue;
      }
      seen.add(record.externalId);

      const result = await this.upsert.upsertOne(
        tenantId,
        resource,
        dto.connectionId,
        policy,
        record.externalId,
        record.data,
        actor,
        { safe: true, dryRun },
      );
      this.tally(summary, result.outcome);
      summary.results.push({
        externalId: result.externalId,
        outcome: result.outcome,
        internalId: result.internalId,
        changedFields: result.changedFields,
        error: result.error,
      });
    }

    if (!dryRun) {
      await this.connections.markSuccess(connection.id);
      await this.audit.record(INTEGRATION_AUDIT_ACTION.IMPORT, tenantId, resource, connection.id, actor, {
        connectionId: dto.connectionId,
        resourceType: resource,
        total: summary.total,
        created: summary.created,
        updated: summary.updated,
        linked: summary.linked,
        skipped: summary.skipped,
        conflicted: summary.conflicted,
        failed: summary.failed,
      });
    }

    return summary;
  }

  private tally(summary: ImportSummary, outcome: string): void {
    switch (outcome) {
      case UPSERT_OUTCOME.CREATED: summary.created += 1; break;
      case UPSERT_OUTCOME.UPDATED: summary.updated += 1; break;
      case UPSERT_OUTCOME.LINKED: summary.linked += 1; break;
      case UPSERT_OUTCOME.SKIPPED: summary.skipped += 1; break;
      case UPSERT_OUTCOME.CONFLICTED: summary.conflicted += 1; break;
      case UPSERT_OUTCOME.FAILED: summary.failed += 1; break;
    }
  }
}

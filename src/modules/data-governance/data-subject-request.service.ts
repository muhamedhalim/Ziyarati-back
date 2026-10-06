import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EMAIL_SOURCE } from '../../common/utils/log-scrubber.util';
import { redactProhibitedIdentifiers } from '../../common/utils/prohibited-content.util';
import { AppError, ErrorCode } from '../../common/errors';
import {
  DataSubjectRequest,
  type DsrStatus,
  type DsrType,
} from '../../entities/Governance/DataSubjectRequest';
import { ClinicalAccessLogService } from '../medical-records/clinical-access-log.service';
import {
  SubjectErasureService,
  type ClinicalChoice,
  type EraseResult,
} from './subject-erasure.service';
import {
  SubjectExportService,
  type SubjectExport,
} from './subject-export.service';

export interface CreateRequestInput {
  customerId: string;
  type: DsrType;
  channel: string;
  note?: string;
}

const TERMINAL: ReadonlySet<DsrStatus> = new Set(['COMPLETED', 'REJECTED']);

/**
 * The lifecycle and audit trail of data-subject requests (residency plan P13).
 *
 * What is AUTOMATED and what is not, stated plainly:
 *  - EXPORT       built from the patient's records, recorded in the read-audit.
 *  - DELETION     executes the erasure plan with an explicit clinical choice and
 *                 stores deletion evidence.
 *  - RESTRICTION  records the request and applies ONE measure: the patient is
 *                 opted out of all marketing. It does NOT stop operational
 *                 processing (reminders, clinical use) — whether and how it must
 *                 is a legal question this does not answer.
 *  - CORRECTION   recorded only. The correction itself is made through the normal
 *                 customer edit; this row is the proof it was requested and closed.
 *
 * The response deadline is NOT assumed: `due_at` is set only when
 * `DSR_RESPONSE_DAYS` is configured.
 */
@Injectable()
export class DataSubjectRequestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly exporter: SubjectExportService,
    private readonly eraser: SubjectErasureService,
    private readonly accessLog: ClinicalAccessLogService,
  ) {}

  private get repo() {
    return this.dataSource.getRepository(DataSubjectRequest);
  }

  /** The note is a procedural remark; refuse one that carries the patient's data into the trail. */
  private assertNoPersonalData(note?: string): void {
    if (!note) return;
    const hasIdentifier = redactProhibitedIdentifiers(note) !== note;
    const hasEmail = new RegExp(EMAIL_SOURCE).test(note);
    const hasPhoneLikeRun = /\d[\d\s().+-]{6,}\d/.test(note);
    if (hasIdentifier || hasEmail || hasPhoneLikeRun) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message:
          'The note must not contain an identifier, email or phone number; refer to the patient by record.',
      });
    }
  }

  private dueAt(from: Date): Date | null {
    const days = Number(this.config.get<number | string>('DSR_RESPONSE_DAYS'));
    return Number.isFinite(days) && days > 0
      ? new Date(from.getTime() + days * 86_400_000)
      : null;
  }

  async create(
    tenantId: string,
    userId: string,
    input: CreateRequestInput,
  ): Promise<DataSubjectRequest> {
    this.assertNoPersonalData(input.note);
    const found: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "customers" WHERE "id" = $1 AND "tenantId" = $2`,
      [input.customerId, tenantId],
    );
    if (found.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Customer not found in this clinic.',
      });
    }
    const now = new Date();
    return this.repo.save(
      this.repo.create({
        tenant_id: tenantId,
        customer_id: input.customerId,
        type: input.type,
        status: 'RECEIVED',
        channel: input.channel,
        received_at: now,
        due_at: this.dueAt(now),
        requested_by_user_id: userId,
        note: input.note ?? null,
      }),
    );
  }

  async list(
    tenantId: string,
    filter: {
      status?: DsrStatus;
      customerId?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    data: DataSubjectRequest[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));
    const where: Record<string, unknown> = { tenant_id: tenantId };
    if (filter.status) where.status = filter.status;
    if (filter.customerId) where.customer_id = filter.customerId;
    const [data, total] = await this.repo.findAndCount({
      where,
      order: { received_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  async get(tenantId: string, id: string): Promise<DataSubjectRequest> {
    const row = await this.repo.findOne({ where: { id, tenant_id: tenantId } });
    if (!row)
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Request not found.',
      });
    return row;
  }

  /** Loads a request and refuses one that is finished or of the wrong type. */
  private async open(
    tenantId: string,
    id: string,
    type?: DsrType,
  ): Promise<DataSubjectRequest> {
    const req = await this.get(tenantId, id);
    if (TERMINAL.has(req.status)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `This request is already ${req.status.toLowerCase()}.`,
      });
    }
    if (type && req.type !== type) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `This is a ${req.type} request, not ${type}.`,
      });
    }
    return req;
  }

  private async finish(
    req: DataSubjectRequest,
    userId: string,
    status: DsrStatus,
    outcome: Record<string, unknown>,
    extra: Partial<DataSubjectRequest> = {},
  ): Promise<DataSubjectRequest> {
    Object.assign(req, extra, {
      status,
      handled_by_user_id: userId,
      outcome,
      completed_at: TERMINAL.has(status) ? new Date() : null,
    });
    return this.repo.save(req);
  }

  /** EXPORT: builds the document, records the read, closes the request. */
  async fulfilExport(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<{ request: DataSubjectRequest; export: SubjectExport }> {
    const req = await this.open(tenantId, id, 'EXPORT');
    const exported = await this.exporter.build(tenantId, req.customer_id);
    await this.accessLog.record(tenantId, req.customer_id, userId, 'export');
    const request = await this.finish(req, userId, 'COMPLETED', {
      sections: exported.counts,
      truncated: exported.truncated,
    });
    return { request, export: exported };
  }

  /**
   * DELETION: runs the erasure plan. A dry run returns the report and leaves the
   * request open; a real run closes it only when the erasure was COMPLETE — a
   * PARTIAL result (e.g. a stored object could not be purged) keeps it IN_PROGRESS.
   */
  async fulfilDeletion(
    tenantId: string,
    userId: string,
    id: string,
    options: { clinical: ClinicalChoice; dryRun?: boolean },
  ): Promise<{ request: DataSubjectRequest; result: EraseResult }> {
    const req = await this.open(tenantId, id, 'DELETION');
    const result = await this.eraser.erase(tenantId, req.customer_id, {
      clinical: options.clinical,
      dryRun: options.dryRun,
      requestId: req.id,
      performedByUserId: userId,
    });
    if (result.dryRun) return { request: req, result };

    await this.accessLog.record(tenantId, req.customer_id, userId, 'erasure');
    const complete = result.status === 'COMPLETED';
    const request = await this.finish(
      req,
      userId,
      complete ? 'COMPLETED' : 'IN_PROGRESS',
      { clinical: options.clinical, erasure: result.status },
      { evidence_id: result.evidenceId ?? null },
    );
    return { request, result };
  }

  /** RESTRICTION: records the request and applies the marketing opt-out — nothing more is claimed. */
  async fulfilRestriction(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<DataSubjectRequest> {
    const req = await this.open(tenantId, id, 'RESTRICTION');
    await this.dataSource.query(
      `UPDATE "customers"
          SET "marketing_opt_in" = false,
              "opted_out_at" = COALESCE("opted_out_at", now()),
              "opt_out_source" = COALESCE("opt_out_source", 'dsr_restriction'),
              "updated_at" = now()
        WHERE "id" = $1 AND "tenantId" = $2`,
      [req.customer_id, tenantId],
    );
    return this.finish(req, userId, 'COMPLETED', {
      applied: ['marketing_opt_out'],
      notApplied:
        'Operational processing (reminders, clinical use) is unchanged; whether it must be restricted is a legal decision.',
    });
  }

  /** Manual close — the route for CORRECTION (made through the normal edit) and for a refusal. */
  async close(
    tenantId: string,
    userId: string,
    id: string,
    status: 'COMPLETED' | 'REJECTED',
    note?: string,
  ): Promise<DataSubjectRequest> {
    this.assertNoPersonalData(note);
    const req = await this.open(tenantId, id);
    return this.finish(
      req,
      userId,
      status,
      { closedManually: true },
      note ? { note } : {},
    );
  }
}

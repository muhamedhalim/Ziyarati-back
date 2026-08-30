import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ClinicalEncounter } from '../../entities/Clinical/ClinicalEncounter';
import { ClinicalEntry } from '../../entities/Clinical/ClinicalEntry';
import { ClinicalEntryRevision } from '../../entities/Clinical/ClinicalEntryRevision';
import { ClinicalEntryKind } from '../../entities/enums';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Customer } from '../../entities/CRM/Customer';
import { User } from '../../entities/Auth&RBAC/User';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { AppError, ErrorCode } from '../../common/errors';

import {
  CreateClinicalEncounterDto,
  CreateClinicalEntryDto,
  CorrectClinicalEntryDto,
} from './dto/clinical-entry.dto';
import {
  ClinicalNoteDataDto,
  ClinicalDiagnosisDataDto,
  ClinicalMedicationDataDto,
  ClinicalAllergyDataDto,
  ClinicalVitalsDataDto,
} from './dto/clinical-entry-data.dto';

const DATA_DTO_BY_KIND: Record<ClinicalEntryKind, new () => object> = {
  [ClinicalEntryKind.NOTE]: ClinicalNoteDataDto,
  [ClinicalEntryKind.DIAGNOSIS]: ClinicalDiagnosisDataDto,
  [ClinicalEntryKind.MEDICATION]: ClinicalMedicationDataDto,
  [ClinicalEntryKind.ALLERGY]: ClinicalAllergyDataDto,
  [ClinicalEntryKind.VITALS]: ClinicalVitalsDataDto,
};

/**
 * Spec 014 (Clinic Platform Completion) — T107 (US6, FR-H001–H003, FR-H008,
 * FR-H009, FR-H013, FR-H014).
 *
 * Creates, corrects and soft-deletes clinical entries and encounters. Every
 * write validates `data` against the DTO its `kind` selects — a rejected
 * input is stored NOWHERE (FR-H013): validation runs entirely before any
 * repository call. The author is always server-set from the authenticated
 * principal (`actorUserId`), never read from the request body.
 */
@Injectable()
export class ClinicalRecordService {
  constructor(
    @InjectRepository(ClinicalEncounter)
    private readonly encounters: Repository<ClinicalEncounter>,
    @InjectRepository(ClinicalEntry)
    private readonly entries: Repository<ClinicalEntry>,
    @InjectRepository(ClinicalEntryRevision)
    private readonly revisions: Repository<ClinicalEntryRevision>,
    private readonly dataSource: DataSource,
  ) {}

  /** Validates `data` against its kind's DTO. Throws BAD_REQUEST on the FIRST violation — nothing is stored on a rejected input. */
  private validateEntryData(
    kind: ClinicalEntryKind,
    data: Record<string, unknown>,
  ): void {
    const DtoClass = DATA_DTO_BY_KIND[kind];
    const instance = plainToInstance(DtoClass, data, {
      excludeExtraneousValues: false,
    });
    const errors = validateSync(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const messages = errors.flatMap((e) =>
        Object.values(e.constraints ?? {}),
      );
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Invalid ${kind.toLowerCase()} entry: ${messages.join('; ')}`,
      });
    }
  }

  async createEncounter(
    tenantId: string,
    customerId: string,
    actorUserId: string,
    dto: CreateClinicalEncounterDto,
  ): Promise<ClinicalEncounter> {
    const encounter = this.encounters.create({
      tenant: { id: tenantId } as Tenant,
      customer: { id: customerId } as Customer,
      appointment: dto.appointmentId
        ? ({ id: dto.appointmentId } as Appointment)
        : undefined,
      branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
      author: { id: actorUserId } as User,
      occurred_at: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      summary: dto.summary,
    });
    return this.encounters.save(encounter);
  }

  /** `encounterId` omitted → a patient-level entry (e.g. a standing allergy with no visit). */
  async createEntry(
    tenantId: string,
    customerId: string,
    actorUserId: string,
    dto: CreateClinicalEntryDto,
    encounterId?: string,
  ): Promise<ClinicalEntry> {
    this.validateEntryData(dto.kind, dto.data);

    const entry = this.entries.create({
      tenant: { id: tenantId } as Tenant,
      customer: { id: customerId } as Customer,
      encounter: encounterId
        ? ({ id: encounterId } as ClinicalEncounter)
        : undefined,
      kind: dto.kind,
      data: dto.data,
      recorded_at: dto.recordedAt ? new Date(dto.recordedAt) : new Date(),
      author: { id: actorUserId } as User,
    });
    return this.entries.save(entry);
  }

  /**
   * Correction (FR-H008/H009): the prior payload is written to
   * `clinical_entry_revisions` in the SAME transaction as the update.
   * A stale `dto.version` is rejected with 409 BEFORE any write — an
   * explicit check against the client's own view, backed by TypeORM's
   * `@VersionColumn` save-time check as defense-in-depth against a tighter
   * concurrent race between the read and the write.
   */
  async correctEntry(
    tenantId: string,
    entryId: string,
    actorUserId: string,
    dto: CorrectClinicalEntryDto,
  ): Promise<ClinicalEntry> {
    return this.dataSource.transaction(async (manager) => {
      const entryRepo = manager.getRepository(ClinicalEntry);
      const entry = await entryRepo.findOne({
        where: { id: entryId, tenant: { id: tenantId } },
      });
      if (!entry) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Entry not found' });
      }
      if (entry.version !== dto.version) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'This entry was modified by someone else. Reload and try again.',
        });
      }

      this.validateEntryData(entry.kind, dto.data);

      await manager.getRepository(ClinicalEntryRevision).save(
        manager.getRepository(ClinicalEntryRevision).create({
          tenant: { id: tenantId } as Tenant,
          entry: { id: entryId } as ClinicalEntry,
          previous_data: entry.data,
          changed_by: { id: actorUserId } as User,
        }),
      );

      entry.data = dto.data;
      return entryRepo.save(entry);
    });
  }

  /** Soft delete only (FR-H014) — clinical content is never destroyed. */
  async softDeleteEntry(tenantId: string, entryId: string): Promise<void> {
    const entry = await this.entries.findOne({
      where: { id: entryId, tenant: { id: tenantId } },
    });
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Entry not found' });
    }
    await this.entries.softDelete(entry.id);
  }

  /** `GET /clinical/encounters/:id`. Cross-tenant is a 404, indistinguishable from non-existent. */
  async getEncounter(tenantId: string, id: string): Promise<ClinicalEncounter> {
    const encounter = await this.encounters.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: {
        author: true,
        appointment: true,
        branch: true,
        customer: true,
      },
    });
    if (!encounter) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Encounter not found',
      });
    }
    return encounter;
  }

  /** `GET /clinical/entries/:id/revisions` — append-only history, newest first. */
  async listRevisions(
    tenantId: string,
    entryId: string,
  ): Promise<ClinicalEntryRevision[]> {
    const entry = await this.entries.findOne({
      where: { id: entryId, tenant: { id: tenantId } },
    });
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Entry not found' });
    }
    return this.revisions.find({
      where: { entry: { id: entryId } },
      relations: { changed_by: true },
      order: { created_at: 'DESC' },
    });
  }

  /** `GET /clinical/entries/:id` — used by the controller to resolve `customerId` for the access-log write. */
  async getEntry(tenantId: string, entryId: string): Promise<ClinicalEntry> {
    const entry = await this.entries.findOne({
      where: { id: entryId, tenant: { id: tenantId } },
      relations: { customer: true, author: true },
    });
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Entry not found' });
    }
    return entry;
  }
}

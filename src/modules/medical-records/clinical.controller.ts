import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ClinicalRecordService } from './clinical-record.service';
import { ClinicalTimelineService } from './clinical-timeline.service';
import { ClinicalAccessLogService } from './clinical-access-log.service';
import {
  CreateClinicalEncounterDto,
  CreateClinicalEntryDto,
  CorrectClinicalEntryDto,
} from './dto/clinical-entry.dto';
import { QueryClinicalTimelineDto } from './dto/query-clinical-timeline.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

/**
 * Spec 014 (Clinic Platform Completion) — T112 (US6, contracts/clinic-
 * surfaces.md §F6). The 9 clinical routes. Every route requires
 * `clinical.records.read` or `.manage` — a permission distinct from, and in
 * ADDITION to, ordinary patient-record access (FR-H010). Every READ writes
 * a `clinical_access_logs` row (FR-H011). Cross-tenant customer/entry ids
 * are the same 404 as non-existent ones — this surface must not let a
 * viewer enumerate data they could not otherwise see.
 *
 * Entitlement policy (T026A): `@RequireFeature(FeatureKey.CRM)` at the
 * controller level — clinical records extend the patient-record domain,
 * they are not a separate entitlement.
 */
@ApiTags('Clinical Records')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CRM)
@Controller('clinical')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ClinicalController {
  constructor(
    private readonly records: ClinicalRecordService,
    private readonly timeline: ClinicalTimelineService,
    private readonly accessLog: ClinicalAccessLogService,
    private readonly ctx: TenantContextService,
  ) {}

  private requireActorId(): string {
    const id = this.ctx.getUser()?.id;
    if (!id) {
      throw new Error('ClinicalController: no authenticated user on request');
    }
    return id;
  }

  @ApiOperation({
    summary: "Patient's clinical timeline",
    description:
      '**Protected — `clinical.records.read`.** Reverse-chronological encounters, entries and files (FR-H006).',
  })
  @ApiParam({ name: 'customerId', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Paginated timeline.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Get('patients/:customerId/timeline')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_READ)
  async getTimeline(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: QueryClinicalTimelineDto,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const page = await this.timeline.getTimeline(
      tenantId,
      customerId,
      query.page,
      query.limit,
    );
    await this.accessLog.record(
      tenantId,
      customerId,
      this.requireActorId(),
      'timeline',
    );
    return page;
  }

  @ApiOperation({
    summary: "Patient's clinical summary",
    description:
      '**Protected — `clinical.records.read`.** Active allergies (FR-H007) + legacy free-text profile content (FR-H004).',
  })
  @ApiParam({ name: 'customerId', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Allergies + legacy profile summary.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Get('patients/:customerId/summary')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_READ)
  async getSummary(@Param('customerId', ParseUUIDPipe) customerId: string) {
    const tenantId = this.ctx.requireTenantId();
    const summary = await this.timeline.getSummary(tenantId, customerId);
    await this.accessLog.record(
      tenantId,
      customerId,
      this.requireActorId(),
      'summary',
    );
    return summary;
  }

  @ApiOperation({
    summary: 'Create a clinical encounter',
    description: '**Protected — `clinical.records.manage`.**',
  })
  @ApiParam({ name: 'customerId', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Encounter created.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Post('patients/:customerId/encounters')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_MANAGE)
  createEncounter(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateClinicalEncounterDto,
  ) {
    return this.records.createEncounter(
      this.ctx.requireTenantId(),
      customerId,
      this.requireActorId(),
      dto,
    );
  }

  @ApiOperation({
    summary: 'Get a clinical encounter',
    description:
      "**Protected — `clinical.records.read`.** Valid regardless of whether its appointment was later cancelled (FR-H005). Another tenant's encounter is a 404.",
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Encounter.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @ApiNotFoundResponse({ schema: S_ERROR })
  @Get('encounters/:id')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_READ)
  async getEncounter(@Param('id', ParseUUIDPipe) id: string) {
    const tenantId = this.ctx.requireTenantId();
    const encounter = await this.records.getEncounter(tenantId, id);
    await this.accessLog.record(
      tenantId,
      encounter.customer.id,
      this.requireActorId(),
      'entry',
    );
    return encounter;
  }

  @ApiOperation({
    summary: 'Add an entry to an encounter',
    description: '**Protected — `clinical.records.manage`.**',
  })
  @ApiParam({
    name: 'id',
    description: 'Encounter UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({ description: 'Entry created.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @ApiNotFoundResponse({ schema: S_ERROR })
  @Post('encounters/:id/entries')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_MANAGE)
  async createEncounterEntry(
    @Param('id', ParseUUIDPipe) encounterId: string,
    @Body() dto: CreateClinicalEntryDto,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const encounter = await this.records.getEncounter(tenantId, encounterId);
    return this.records.createEntry(
      tenantId,
      encounter.customer.id,
      this.requireActorId(),
      dto,
      encounterId,
    );
  }

  @ApiOperation({
    summary: 'Add a patient-level entry (no visit — e.g. a standing allergy)',
    description: '**Protected — `clinical.records.manage`.**',
  })
  @ApiParam({ name: 'customerId', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Entry created.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Post('patients/:customerId/entries')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_MANAGE)
  createPatientEntry(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateClinicalEntryDto,
  ) {
    return this.records.createEntry(
      this.ctx.requireTenantId(),
      customerId,
      this.requireActorId(),
      dto,
    );
  }

  @ApiOperation({
    summary: 'Correct a clinical entry',
    description:
      '**Protected — `clinical.records.manage`.** Requires the CURRENT `version` — a stale value is refused with 409 (FR-H009). ' +
      'The prior content is preserved as a revision in the same transaction (FR-H008).',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Entry corrected.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @ApiNotFoundResponse({ schema: S_ERROR })
  @ApiConflictResponse({
    description: 'Stale version — reload and try again.',
    schema: S_ERROR,
  })
  @Patch('entries/:id')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_MANAGE)
  correctEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectClinicalEntryDto,
  ) {
    return this.records.correctEntry(
      this.ctx.requireTenantId(),
      id,
      this.requireActorId(),
      dto,
    );
  }

  @ApiOperation({
    summary: 'Delete a clinical entry (soft only)',
    description:
      '**Protected — `clinical.records.manage`.** Soft delete only — clinical content is never destroyed (FR-H014).',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Entry soft-deleted.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @ApiNotFoundResponse({ schema: S_ERROR })
  @Delete('entries/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_MANAGE)
  async deleteEntry(@Param('id', ParseUUIDPipe) id: string) {
    await this.records.softDeleteEntry(this.ctx.requireTenantId(), id);
    return { id, deleted: true };
  }

  @ApiOperation({
    summary: 'List an entry’s revision history',
    description:
      '**Protected — `clinical.records.read`.** Append-only, newest first (FR-H008).',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Revisions.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @ApiNotFoundResponse({ schema: S_ERROR })
  @Get('entries/:id/revisions')
  @RequirePermissions(PERMISSION.CLINICAL_RECORDS_READ)
  async getRevisions(@Param('id', ParseUUIDPipe) id: string) {
    const tenantId = this.ctx.requireTenantId();
    const entry = await this.records.getEntry(tenantId, id);
    const revisions = await this.records.listRevisions(tenantId, id);
    await this.accessLog.record(
      tenantId,
      entry.customer.id,
      this.requireActorId(),
      'entry',
      id,
    );
    return revisions;
  }
}

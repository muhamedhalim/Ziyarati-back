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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CustomerNoteService } from './customer-note.service';
import { ClinicalAccessLogService } from '../medical-records/clinical-access-log.service';
import { CreateCustomerNoteDto } from './dto/create-customer-note.dto';
import { UpdateCustomerNoteDto } from './dto/update-customer-note.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';

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
 * Internal (staff-only) customer notes. Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext. The authoring user is taken
 * from the principal, not from input.
 */
@ApiTags('CRM Customer Notes')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CRM)
@Controller('crm/customers/:customerId/notes')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerNoteController {
  constructor(
    private readonly notes: CustomerNoteService,
    private readonly ctx: TenantContextService,
    // Residency plan P14 — reads of D4 data are accounted for (who, which patient, when).
    private readonly accessLog: ClinicalAccessLogService,
  ) {}

  @ApiOperation({
    summary: 'Add a note',
    description:
      '**Protected — `crm.notes.manage`. Clinic active.** Records the authoring user.',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({ description: 'Note added.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.notes.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.CRM_NOTES_MANAGE)
  add(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerNoteDto,
  ) {
    return this.notes.add(
      this.ctx.requireTenantId(),
      customerId,
      dto,
      this.ctx.getUser()?.id,
    );
  }

  @ApiOperation({
    summary: 'List notes',
    description:
      '**Protected — `crm.notes.read`. Clinic active.** Tenant + customer scoped, newest first, paginated.',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Paginated notes.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.notes.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.CRM_NOTES_READ)
  async list(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const page = await this.notes.list(tenantId, customerId, query);
    const userId = this.ctx.getUser()?.id;
    if (userId)
      await this.accessLog.record(tenantId, customerId, userId, 'notes');
    return page;
  }

  @ApiOperation({
    summary: 'Update a note',
    description: '**Protected — `crm.notes.manage`. Clinic active.**',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'noteId',
    description: 'Note UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Note updated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.notes.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Note not found in this tenant.',
    schema: S_ERROR,
  })
  @Patch(':noteId')
  @RequirePermissions(PERMISSION.CRM_NOTES_MANAGE)
  update(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: UpdateCustomerNoteDto,
  ) {
    return this.notes.update(
      this.ctx.requireTenantId(),
      customerId,
      noteId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Delete a note',
    description: '**Protected — `crm.notes.manage`. Clinic active.**',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'noteId',
    description: 'Note UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Note deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.notes.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Note not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':noteId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_NOTES_MANAGE)
  remove(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ) {
    return this.notes.remove(this.ctx.requireTenantId(), customerId, noteId);
  }
}

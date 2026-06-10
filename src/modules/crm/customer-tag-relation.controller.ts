import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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

import { CustomerTagRelationService } from './customer-tag-relation.service';
import { AssignTagDto } from './dto/assign-tag.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

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
 * Customer ↔ tag assignments. Guarded by PermissionsGuard + ActiveTenantGuard;
 * tenant id from TenantContext. Both customer and tag are tenant-verified before
 * any change.
 */
@ApiTags('CRM Customer Tag Assignments')
@ApiBearerAuth('JWT-auth')
@Controller('crm/customers/:customerId/tags')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class CustomerTagRelationController {
  constructor(
    private readonly relations: CustomerTagRelationService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Assign a tag to a customer', description: '**Protected — `crm.tags.manage`. Clinic active.** Idempotent — re-assigning returns the existing link.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Tag assigned.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.tags.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer or tag not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CRM_TAGS_MANAGE)
  assign(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: AssignTagDto,
  ) {
    return this.relations.assign(this.ctx.requireTenantId(), customerId, dto.tagId);
  }

  @ApiOperation({ summary: 'List a customer\'s tags', description: '**Protected — `crm.tags.read`. Clinic active.** Tags assigned to the customer.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Assigned tags.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.tags.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CRM_TAGS_READ)
  list(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.relations.listForCustomer(this.ctx.requireTenantId(), customerId);
  }

  @ApiOperation({ summary: 'Remove a tag from a customer', description: '**Protected — `crm.tags.manage`. Clinic active.**' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'tagId', description: 'Tag UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Tag removed from customer.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.tags.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found, or tag not assigned.', schema: S_ERROR })
  @Delete(':tagId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_TAGS_MANAGE)
  remove(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
  ) {
    return this.relations.remove(this.ctx.requireTenantId(), customerId, tagId);
  }
}

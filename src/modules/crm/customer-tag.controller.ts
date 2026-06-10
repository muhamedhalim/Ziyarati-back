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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CustomerTagService } from './customer-tag.service';
import { CreateCustomerTagDto } from './dto/create-customer-tag.dto';
import { UpdateCustomerTagDto } from './dto/update-customer-tag.dto';
import { QueryCustomerTagsDto } from './dto/query-customer-tags.dto';

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
 * Customer tag catalogue. Guarded by PermissionsGuard + ActiveTenantGuard;
 * tenant id from TenantContext.
 */
@ApiTags('CRM Customer Tags')
@ApiBearerAuth('JWT-auth')
@Controller('crm/tags')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class CustomerTagController {
  constructor(
    private readonly tags: CustomerTagService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Create a tag', description: '**Protected — `crm.tags.manage`. Clinic active.** Name unique per tenant (409 on conflict).' })
  @ApiCreatedResponse({ description: 'Tag created.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.tags.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Tag name already exists.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CRM_TAGS_MANAGE)
  create(@Body() dto: CreateCustomerTagDto) {
    return this.tags.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List tags', description: '**Protected — `crm.tags.read`. Clinic active.** Tenant-scoped, optional name search + pagination.' })
  @ApiOkResponse({ description: 'Paginated tags.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.tags.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CRM_TAGS_READ)
  list(@Query() query: QueryCustomerTagsDto) {
    return this.tags.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({ summary: 'Update a tag', description: '**Protected — `crm.tags.manage`. Clinic active.**' })
  @ApiParam({ name: 'id', description: 'Tag UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Tag updated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.tags.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Tag not found in this tenant.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Tag name already exists.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.CRM_TAGS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerTagDto) {
    return this.tags.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Delete a tag', description: '**Protected — `crm.tags.manage`. Clinic active.** Removes the tag and its customer assignments (cascade).' })
  @ApiParam({ name: 'id', description: 'Tag UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Tag deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.tags.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Tag not found in this tenant.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_TAGS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.tags.remove(this.ctx.requireTenantId(), id);
  }
}

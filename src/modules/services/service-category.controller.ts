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

import { ServiceCategoryService } from './service-category.service';
import { CreateServiceCategoryDto } from './dto/create-service-category.dto';
import { UpdateServiceCategoryDto } from './dto/update-service-category.dto';
import { QueryServiceCategoriesDto } from './dto/query-service-categories.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';

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
 * Service categories. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id
 * always from TenantContext (never request input). Reuses the existing granular
 * `services.*` permission family.
 *
 * NOTE: this controller is registered BEFORE ServiceController in the module so
 * the static `services/categories` path is never shadowed by `services/:id`.
 */
@ApiTags('Service Categories')
@ApiBearerAuth('JWT-auth')
@Controller('services/categories')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ServiceCategoryController {
  constructor(
    private readonly categories: ServiceCategoryService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List service categories',
    description: '**Protected — `services.read`. Clinic active.** Tenant-scoped, newest first, optional name search + active filter + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated categories: `{ data, total, page, limit }`.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `services.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.SERVICES_READ)
  list(@Query() query: QueryServiceCategoriesDto) {
    return this.categories.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get a service category',
    description: '**Protected — `services.read`. Clinic active.** Another tenant\'s category returns 404.',
  })
  @ApiParam({ name: 'id', description: 'Category UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Category details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `services.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Category not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.SERVICES_READ)
  getDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.getDetails(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Create a service category',
    description: '**Protected — `services.create`. Clinic active.** `name` is unique per tenant (409 on conflict).',
  })
  @ApiCreatedResponse({ description: 'Category created.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `services.create`, or clinic inactive.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Duplicate category name.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.SERVICES_CREATE)
  create(@Body() dto: CreateServiceCategoryDto) {
    return this.categories.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Update a service category',
    description: '**Protected — `services.update`. Clinic active.** Partial update; name uniqueness re-checked when changed.',
  })
  @ApiParam({ name: 'id', description: 'Category UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Category updated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `services.update`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Category not found in this tenant.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Duplicate category name.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.SERVICES_UPDATE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceCategoryDto) {
    return this.categories.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Delete a service category (soft)',
    description: '**Protected — `services.delete`. Clinic active.** Soft-deletes the category. Rejected with 409 while the category still owns services.',
  })
  @ApiParam({ name: 'id', description: 'Category UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Category soft-deleted: `{ id, deleted: true }`.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `services.delete`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Category not found in this tenant.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Category still owns services.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SERVICES_DELETE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.remove(this.ctx.requireTenantId(), id);
  }
}

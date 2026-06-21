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

import { CustomerService } from './customer.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { SearchCustomersDto } from './dto/search-customers.dto';

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
 * Customers. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id always
 * from TenantContext (never request input).
 */
@ApiTags('CRM Customers')
@ApiBearerAuth('JWT-auth')
@Controller('crm/customers')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerController {
  constructor(
    private readonly customers: CustomerService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Create a customer', description: '**Protected — `crm.customers.manage`. Clinic active.** Phone is unique per tenant; email is globally unique (409 on conflict).' })
  @ApiCreatedResponse({ description: 'Customer created.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Duplicate phone or email.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List customers', description: '**Protected — `crm.customers.read`. Clinic active.** Tenant-scoped, newest first, optional active filter + pagination.' })
  @ApiOkResponse({ description: 'Paginated customers.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  list(@Query() query: QueryCustomersDto) {
    return this.customers.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({ summary: 'Search customers', description: '**Protected — `crm.customers.read`. Clinic active.** Partial match on name/email/phone + optional tag filter, tenant-scoped.' })
  @ApiOkResponse({ description: 'Paginated search results.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.read`, or clinic inactive.', schema: S_ERROR })
  @Get('search')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  search(@Query() query: SearchCustomersDto) {
    return this.customers.search(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({ summary: 'Get customer details', description: '**Protected — `crm.customers.read`. Clinic active.** Includes profile, addresses and assigned tags. Another tenant\'s customer returns 404.' })
  @ApiParam({ name: 'id', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Customer details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  getDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.getDetails(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update a customer', description: '**Protected — `crm.customers.manage`. Clinic active.** Partial update; phone uniqueness re-checked when changed.' })
  @ApiParam({ name: 'id', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Customer updated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Duplicate phone or email.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Delete a customer (soft)', description: '**Protected — `crm.customers.manage`. Clinic active.** Soft-deletes the customer (`deleted_at`).' })
  @ApiParam({ name: 'id', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Customer soft-deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(this.ctx.requireTenantId(), id);
  }
}

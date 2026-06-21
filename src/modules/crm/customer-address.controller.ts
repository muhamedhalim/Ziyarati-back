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

import { CustomerAddressService } from './customer-address.service';
import { CreateCustomerAddressDto } from './dto/create-customer-address.dto';
import { UpdateCustomerAddressDto } from './dto/update-customer-address.dto';

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
 * Customer addresses (1:N). Guarded by PermissionsGuard + ActiveTenantGuard;
 * tenant id from TenantContext. Uses the customer permissions.
 */
@ApiTags('CRM Customer Addresses')
@ApiBearerAuth('JWT-auth')
@Controller('crm/customers/:customerId/addresses')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerAddressController {
  constructor(
    private readonly addresses: CustomerAddressService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Add an address', description: '**Protected — `crm.customers.manage`. Clinic active.** Setting default unsets the others.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Address added.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  add(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerAddressDto,
  ) {
    return this.addresses.add(this.ctx.requireTenantId(), customerId, dto);
  }

  @ApiOperation({ summary: 'List addresses', description: '**Protected — `crm.customers.read`. Clinic active.** Tenant + customer scoped; default first.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Customer addresses.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  list(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.addresses.list(this.ctx.requireTenantId(), customerId);
  }

  @ApiOperation({ summary: 'Update an address', description: '**Protected — `crm.customers.manage`. Clinic active.**' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'addressId', description: 'Address UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Address updated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Address not found in this tenant.', schema: S_ERROR })
  @Patch(':addressId')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  update(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateCustomerAddressDto,
  ) {
    return this.addresses.update(this.ctx.requireTenantId(), customerId, addressId, dto);
  }

  @ApiOperation({ summary: 'Delete an address', description: '**Protected — `crm.customers.manage`. Clinic active.**' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'addressId', description: 'Address UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Address deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.customers.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Address not found in this tenant.', schema: S_ERROR })
  @Delete(':addressId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  remove(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.addresses.remove(this.ctx.requireTenantId(), customerId, addressId);
  }
}

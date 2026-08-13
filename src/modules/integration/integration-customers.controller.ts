import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

import { CustomerService } from '../crm/customer.service';
import { QueryCustomersDto } from '../crm/dto/query-customers.dto';
import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { INTEGRATION_SCOPE } from '../platform/integration-scopes.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { toIntegrationCustomer } from './integration.mappers';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * Read-only external view of clinic customers. Delegates to the existing
 * tenant-scoped CustomerService. Excludes internal CRM metadata (whatsapp
 * linkage, gender, date of birth, marketing opt-in, source) and every
 * sub-resource (notes/files/addresses/tags) — only the fields a clinic
 * integration needs to identify and reference a customer record.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('integrations/customers')
export class IntegrationCustomersController {
  constructor(
    private readonly customers: CustomerService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List customers',
    description:
      'Requires scope `integration.customers.read`. Paginated (max 100/page).',
  })
  @ApiOkResponse({ description: 'Paginated customers.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.CUSTOMERS_READ)
  @Get()
  async list(@Query() query: QueryCustomersDto) {
    const result = await this.customers.list(this.ctx.requireTenantId(), query);
    return { ...result, data: result.data.map(toIntegrationCustomer) };
  }

  @ApiOperation({
    summary: 'Get a customer',
    description:
      'Requires scope `integration.customers.read`. A customer from another tenant returns 404.',
  })
  @ApiOkResponse({ description: 'Customer detail.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.CUSTOMERS_READ)
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toIntegrationCustomer(
      await this.customers.findOneOrThrow(this.ctx.requireTenantId(), id),
    );
  }
}

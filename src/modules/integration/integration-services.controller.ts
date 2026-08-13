import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

import { ServiceService } from '../services/service.service';
import { QueryServicesDto } from '../services/dto/query-services.dto';
import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { INTEGRATION_SCOPE } from '../platform/integration-scopes.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { toIntegrationService } from './integration.mappers';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * Read-only external view of the service catalog. Delegates entirely to the
 * existing tenant-scoped ServiceService — no duplicated query logic.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('integrations/services')
export class IntegrationServicesController {
  constructor(
    private readonly services: ServiceService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List services',
    description:
      'Requires scope `integration.services.read`. Paginated (max 100/page); same filters as the internal catalog.',
  })
  @ApiOkResponse({ description: 'Paginated services.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.SERVICES_READ)
  @Get()
  async list(@Query() query: QueryServicesDto) {
    const result = await this.services.list(this.ctx.requireTenantId(), query);
    return { ...result, data: result.data.map(toIntegrationService) };
  }

  @ApiOperation({
    summary: 'Get a service',
    description:
      'Requires scope `integration.services.read`. A service from another tenant returns 404.',
  })
  @ApiOkResponse({ description: 'Service detail.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.SERVICES_READ)
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toIntegrationService(
      await this.services.getDetails(this.ctx.requireTenantId(), id),
    );
  }
}

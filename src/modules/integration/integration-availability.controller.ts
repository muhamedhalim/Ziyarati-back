import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { AvailabilityService } from '../scheduling/availability.service';
import { AvailabilityQueryDto } from '../scheduling/dto/availability-query.dto';
import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { INTEGRATION_SCOPE } from '../platform/integration-scopes.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

/**
 * Read-only external view of free/busy windows for a staff member on a given
 * day. Delegates entirely to the existing AvailabilityService (the same
 * engine the internal booking flow uses) — no separate availability model.
 * Requires `branchId`, `staffId`, and `date` (YYYY-MM-DD); see
 * AvailabilityQueryDto.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@Controller('integrations/availability')
export class IntegrationAvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Get free/busy windows for a staff member on a day',
    description:
      'Requires scope `integration.availability.read`. Requires `branchId`, `staffId`, and `date` (YYYY-MM-DD).',
  })
  @ApiOkResponse({ description: 'Free windows for the requested day.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.AVAILABILITY_READ)
  @Get()
  windows(@Query() query: AvailabilityQueryDto) {
    return this.availability.windows(this.ctx.requireTenantId(), query);
  }
}

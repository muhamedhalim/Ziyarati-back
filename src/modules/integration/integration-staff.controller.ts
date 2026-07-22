import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { StaffService } from '../staff/staff.service';
import { QueryStaffDto } from '../staff/dto/query-staff.dto';
import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { INTEGRATION_SCOPE } from '../platform/integration-scopes.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { toIntegrationStaff } from './integration.mappers';

/**
 * Read-only external view of the staff directory. Delegates to the existing
 * tenant-scoped StaffService; the response is a minimal directory projection
 * (name/title/bio/availability) — the linked user's email, phone, roles, and
 * any commission/rating data are never exposed here.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@Controller('integrations/staff')
export class IntegrationStaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List staff',
    description:
      'Requires scope `integration.staff.read`. Paginated (max 100/page). Returns a directory projection only.',
  })
  @ApiOkResponse({ description: 'Paginated staff.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.STAFF_READ)
  @Get()
  async list(@Query() query: QueryStaffDto) {
    const result = await this.staff.findAll(this.ctx.requireTenantId(), query);
    return { ...result, data: result.data.map(toIntegrationStaff) };
  }

  @ApiOperation({
    summary: 'Get a staff member',
    description: 'Requires scope `integration.staff.read`. A staff member from another tenant returns 404.',
  })
  @ApiOkResponse({ description: 'Staff detail.' })
  @ApiKeyProtected(INTEGRATION_SCOPE.STAFF_READ)
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toIntegrationStaff(await this.staff.findOne(this.ctx.requireTenantId(), id));
  }
}

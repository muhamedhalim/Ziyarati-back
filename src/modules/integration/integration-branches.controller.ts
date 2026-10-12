import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { BranchService } from '../tenant/branch.service';
import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { RequireAnyScope } from '../platform/decorators/require-scopes.decorator';
import { INTEGRATION_SCOPE } from '../platform/integration-scopes.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { toIntegrationBranch } from './integration.mappers';
import { QueryIntegrationBranchesDto } from './dto/query-integration-branches.dto';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { ApiIntegrationReadErrors } from './integration-api-docs';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * Read-only branch discovery.
 *
 * Appointment writes and availability queries require an internal `branchId`
 * and branches have no external-id mapping, so an integrator needs a way to
 * learn the ids. Delegates to the existing tenant-scoped BranchService (the
 * tenant comes from the API key, never from the request) and projects only
 * `{ id, name, timezone, isActive }` — no address, phone or WhatsApp number.
 *
 * Authorised by ANY of the scopes whose workflows need a branch id, so existing
 * keys keep working without re-issue and no new scope/permission is introduced.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@ApiIntegrationReadErrors()
@Controller('integrations/branches')
export class IntegrationBranchesController {
  constructor(
    private readonly branches: BranchService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List branches',
    description:
      "Requires ONE of the scopes `integration.availability.read`, `integration.appointments.read` or `integration.appointments.write`. Returns the clinic's own branches (`id`, `name`, `timezone`, `isActive`) so a `branchId` can be used for availability and appointment upserts. Paginated (max 100/page).",
  })
  @ApiOkResponse({ description: "Paginated branches of the key's clinic." })
  @ApiKeyProtected()
  @RequireAnyScope(
    INTEGRATION_SCOPE.AVAILABILITY_READ,
    INTEGRATION_SCOPE.APPOINTMENTS_READ,
    INTEGRATION_SCOPE.APPOINTMENTS_WRITE,
  )
  @Get()
  async list(@Query() query: QueryIntegrationBranchesDto) {
    const all = await this.branches.findAll(this.ctx.requireTenantId());
    const start = (query.page - 1) * query.limit;
    return {
      data: all.slice(start, start + query.limit).map(toIntegrationBranch),
      total: all.length,
      page: query.page,
      limit: query.limit,
    };
  }

  @ApiOperation({
    summary: 'Get a branch',
    description:
      'Same scopes as the list. A branch of another clinic, or an unknown id, returns 404.',
  })
  @ApiOkResponse({ description: 'Branch detail.' })
  @ApiKeyProtected()
  @RequireAnyScope(
    INTEGRATION_SCOPE.AVAILABILITY_READ,
    INTEGRATION_SCOPE.APPOINTMENTS_READ,
    INTEGRATION_SCOPE.APPOINTMENTS_WRITE,
  )
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toIntegrationBranch(await this.branches.findOne(this.ctx.requireTenantId(), id));
  }
}

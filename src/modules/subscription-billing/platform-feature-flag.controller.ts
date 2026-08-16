import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { FeatureCatalogService } from './feature-catalog.service';
import {
  BulkSetTenantFeatureStateDto,
  BulkSetTenantFeaturesDto,
  QueryFeatureDefinitionsDto,
  SetFeatureDependenciesDto,
  SetFeaturePlansDto,
  SetTenantFeatureDto,
  SetTenantFeatureStateDto,
  SetTenantFeatureSuspensionDto,
  UpsertFeatureDefinitionDto,
} from './dto/feature-catalog.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Platform-owner (super-admin) feature management. Manages the feature catalog
 * and toggles features per tenant, reusing the existing feature-flag override
 * store + audit log. Distinct from the tenant self-service `/feature-flags`
 * controller (owner/manager, own tenant only).
 */
@ApiTags('Feature Flags (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/feature-flags')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformFeatureFlagController {
  constructor(private readonly catalog: FeatureCatalogService) {}

  @ApiOperation({ summary: 'List the feature catalog (super-admin)' })
  @ApiOkResponse({
    description: 'Feature definitions (global metadata + defaults).',
  })
  @Get('definitions')
  listDefinitions(@Query() query: QueryFeatureDefinitionsDto) {
    return this.catalog.listDefinitions(query);
  }

  @ApiOperation({
    summary: 'Create or update a feature definition (super-admin)',
    description:
      'Features are DB-driven — add a new one by upserting its definition; nothing is hardcoded.',
  })
  @ApiOkResponse({ description: 'The upserted definition.' })
  @Post('definitions')
  upsertDefinition(
    @Body() dto: UpsertFeatureDefinitionDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.upsertDefinition(dto, { id: userId, ip });
  }

  @ApiOperation({
    summary: "Resolve a tenant's effective features (super-admin)",
    description:
      'Full resolution via the single resolver: subscription state + plan inclusion + global/override enablement + dependency satisfaction + usage quota → `available` + `blockedReason` per feature.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Subscription context + resolved feature list.',
  })
  @Get('tenants/:tenantId/features')
  tenantFeatures(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.catalog.getTenantFeatures(tenantId);
  }

  @ApiOperation({
    summary: 'Set the plans a feature is available on (super-admin)',
    description:
      'Empty list = available on all plans. Plan ids come from the Subscription Module.',
  })
  @ApiParam({ name: 'featureKey' })
  @ApiOkResponse({ description: 'Updated plan availability.' })
  @Put('definitions/:featureKey/plans')
  setPlans(
    @Param('featureKey') featureKey: string,
    @Body() dto: SetFeaturePlansDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.setPlans(featureKey, dto.planIds, { id: userId, ip });
  }

  @ApiOperation({
    summary: "Set a feature's dependencies (super-admin)",
    description:
      'Stores the dependency edges; rejects self- and circular dependencies.',
  })
  @ApiParam({ name: 'featureKey' })
  @ApiOkResponse({ description: 'Updated dependency edges.' })
  @Put('definitions/:featureKey/dependencies')
  setDependencies(
    @Param('featureKey') featureKey: string,
    @Body() dto: SetFeatureDependenciesDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.setDependencies(featureKey, dto.requires, {
      id: userId,
      ip,
    });
  }

  @ApiOperation({ summary: 'Toggle a feature for a tenant (super-admin)' })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'The updated override flag.' })
  @Put('tenants/:tenantId/features')
  setTenantFeature(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SetTenantFeatureDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.setTenantFeature(
      tenantId,
      dto.featureKey,
      dto.enabled,
      {
        id: userId,
        ip,
      },
    );
  }

  @ApiOperation({
    summary: 'Set the administrative state of a tenant capability (super-admin)',
    description:
      'The unified three-way control, and the one the console uses. ' +
      '`granted` records a super-admin override: the clinic may use the capability (and its declared ' +
      'dependency closure) with NO subscription, unmetered by any plan. ' +
      '`inherit` clears the override and hands the decision back to the subscription — it is NOT a denial. ' +
      '`suspended` blocks the capability outright, outranking FREE mode, a paid plan and any override; ' +
      'a reason is required, and always-on capabilities (billing, support, workspace) are refused. ' +
      'Both writes of a transition commit together, so a tenant is never briefly in neither state.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'The updated flag row.' })
  @Put('tenants/:tenantId/features/state')
  setTenantFeatureState(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SetTenantFeatureStateDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.setTenantFeatureState(
      tenantId,
      dto.featureKey,
      dto.state,
      dto.reason,
      { id: userId, ip },
    );
  }

  @ApiOperation({
    summary: 'Apply one administrative state to many capabilities (super-admin)',
    description:
      'All-or-nothing: the whole batch is validated before anything is written, and every key is ' +
      'applied in one transaction.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: '{ updated } count.' })
  @Put('tenants/:tenantId/features/state/bulk')
  bulkSetTenantFeatureState(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: BulkSetTenantFeatureStateDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.bulkSetTenantFeatureState(
      tenantId,
      dto.featureKeys,
      dto.state,
      dto.reason,
      { id: userId, ip },
    );
  }

  @ApiOperation({
    summary: 'Suspend or lift a tenant capability (super-admin)',
    description:
      'The incident kill-switch. A suspension OUTRANKS everything — free platform mode, a paid ' +
      'subscription and any feature override — and is the only control that does. It is distinct ' +
      'from `enabled: false`, which merely means "not granted" and never removes something a paid ' +
      'plan includes. A reason is required to suspend. Always-on capabilities (billing, support, ' +
      'workspace) are refused: a blocked clinic must still be able to pay and ask for help. ' +
      'The flag write and its audit record commit together — a failed audit rolls the suspension back.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: 'The updated flag row.' })
  @Put('tenants/:tenantId/features/suspension')
  setTenantFeatureSuspension(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SetTenantFeatureSuspensionDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.setTenantFeatureSuspension(
      tenantId,
      dto.featureKey,
      dto.suspended,
      dto.reason,
      { id: userId, ip },
    );
  }

  @ApiOperation({
    summary: 'Bulk enable/disable features for a tenant (super-admin)',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({ description: '{ updated } count.' })
  @Put('tenants/:tenantId/features/bulk')
  bulkSetTenantFeatures(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: BulkSetTenantFeaturesDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.catalog.bulkSetTenantFeatures(tenantId, dto, {
      id: userId,
      ip,
    });
  }
}

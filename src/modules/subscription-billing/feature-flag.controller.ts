import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { FeatureFlagService } from './feature-flag.service';
import { FeatureCatalogService } from './feature-catalog.service';
import { SetFeatureFlagDto } from './dto/set-feature-flag.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

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

const S_FLAG = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    feature_key: { type: 'string', example: 'ai.assistant' },
    is_enabled: { type: 'boolean', example: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * Per-tenant feature flags. Guarded by PermissionsGuard; tenant id from
 * TenantContext. Reads need `featureflag.read`; toggling needs
 * `featureflag.manage` (platform/owner-controlled gating).
 */
@ApiTags('Feature Flags')
@ApiBearerAuth('JWT-auth')
@Controller('feature-flags')
@UseGuards(PermissionsGuard)
export class FeatureFlagController {
  constructor(
    private readonly features: FeatureFlagService,
    private readonly catalog: FeatureCatalogService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Resolve my effective features (read-only)',
    description:
      "**Requires `featureflag.read`.** Full resolution for the caller's own tenant — subscription state, plan inclusion, dependencies and usage quota → what's actually available. Read-only: tenants cannot enable features their subscription does not include.",
  })
  @ApiOkResponse({ description: 'Subscription context + resolved feature list.' })
  @Get('effective')
  @RequirePermissions(PERMISSION.FEATUREFLAG_READ)
  effective() {
    return this.catalog.getTenantFeatures(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'List the tenant\'s feature flags',
    description: `
**Protected — requires \`featureflag.read\`.**

Returns all feature flags configured for the caller's tenant. The frontend
uses these to show/hide modules (appointments, AI, WhatsApp, …).

**Who can call this:** Owner, Manager (\`featureflag.read\`).

**Tenant scoping:** Only the caller's own flags.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Feature flags.', schema: { type: 'array', items: S_FLAG } })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `featureflag.read`.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.FEATUREFLAG_READ)
  list() {
    return this.features.list(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Check whether a feature is available',
    description: `
**Protected — requires \`featureflag.read\`.**

Returns \`{ featureKey, enabled }\` for a single feature (default false when
not configured). Lightweight runtime check for conditional UI/flows.

**Who can call this:** Owner, Manager (\`featureflag.read\`).
    `.trim(),
  })
  @ApiQuery({ name: 'featureKey', required: true, description: 'Feature key to check', example: 'ai.assistant' })
  @ApiOkResponse({
    description: 'Feature availability.',
    schema: {
      type: 'object',
      properties: { featureKey: { type: 'string' }, enabled: { type: 'boolean' } },
    },
  })
  @ApiBadRequestResponse({ description: 'Missing featureKey.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `featureflag.read`.', schema: S_ERROR })
  @Get('check')
  @RequirePermissions(PERMISSION.FEATUREFLAG_READ)
  async check(@Query('featureKey') featureKey: string) {
    const enabled = await this.features.isEnabled(
      this.ctx.requireTenantId(),
      featureKey,
    );
    return { featureKey, enabled };
  }

  @ApiOperation({
    summary: 'Enable or disable a feature for the tenant',
    description: `
**Protected — requires \`featureflag.manage\`.**

Upserts the (tenant, featureKey) flag. Enabling/disabling takes effect at the
next feature check (guard- or service-level). Typically platform/owner
controlled.

**Who can call this:** Super-admin / Owner with \`featureflag.manage\`.

**Tenant scoping:** Always the caller's own tenant.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Flag set.', schema: S_FLAG })
  @ApiBadRequestResponse({ description: 'Validation failed (bad featureKey).', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `featureflag.manage`.', schema: S_ERROR })
  @Put()
  @RequirePermissions(PERMISSION.FEATUREFLAG_MANAGE)
  set(@Body() dto: SetFeatureFlagDto) {
    return this.features.set(
      this.ctx.requireTenantId(),
      dto.featureKey,
      dto.isEnabled,
    );
  }
}

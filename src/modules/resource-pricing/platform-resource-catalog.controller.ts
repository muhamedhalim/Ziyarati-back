import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ResourceCatalogAdminService } from './resource-catalog-admin.service';
import { UpdateResourcePriceDto } from './dto/update-resource-price.dto';
import { SetResourceCatalogActiveDto } from './dto/set-resource-catalog-active.dto';
import { QueryResourcePriceHistoryDto } from './dto/query-resource-price-history.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * PLATFORM-ONLY pricing catalog control (super admin), Phase 2.1 — mirrors
 * `PlatformBillingAdminController`'s guard shape exactly
 * (`RolesGuard` + `@Roles(super_admin)`).
 */
@ApiTags('Platform Pricing Catalog (Super Admin)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/resource-catalog')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformResourceCatalogController {
  constructor(private readonly catalog: ResourceCatalogAdminService) {}

  @ApiOperation({ summary: 'List the full catalog, including inactive/unpriced items' })
  @Get()
  listAll() {
    return this.catalog.listAll();
  }

  @ApiOperation({
    summary: 'Paginated price-change audit trail (plan §19 — the Price history tab)',
    description:
      'Optionally scoped to one item via ?itemKey=. Registered BEFORE :itemKey below so "/history" is never swallowed as an itemKey value.',
  })
  @Get('history')
  history(@Query() query: QueryResourcePriceHistoryDto) {
    return this.catalog.history(query);
  }

  @ApiOperation({ summary: 'Get one catalog item by key' })
  @Get(':itemKey')
  get(@Param('itemKey') itemKey: string) {
    return this.catalog.getByKey(itemKey);
  }

  @ApiOperation({
    summary: 'Plan-coverage summary for one item',
    description:
      'How many active plans have a Finite / Unlimited / Not-configured limit for this item\'s plan column — the same numbers the publish gate checks.',
  })
  @Get(':itemKey/coverage')
  coverage(@Param('itemKey') itemKey: string) {
    return this.catalog.coverageFor(itemKey);
  }

  @ApiOperation({
    summary: 'Update an item\'s admin-owned pricing/config fields',
    description:
      'item_key/kind/unit_label/unit_size are code-owned and not editable here.',
  })
  @Patch(':itemKey')
  updatePrice(
    @Param('itemKey') itemKey: string,
    @Body() dto: UpdateResourcePriceDto,
  ) {
    return this.catalog.updatePrice(itemKey, dto);
  }

  @ApiOperation({
    summary: 'Activate or deactivate an item',
    description:
      'Activating refuses (422) unless the item is priced, structurally sellable, and covered by at least one active plan. Deactivating is always allowed.',
  })
  @Post(':itemKey/active')
  @HttpCode(HttpStatus.OK)
  setActive(
    @Param('itemKey') itemKey: string,
    @Body() dto: SetResourceCatalogActiveDto,
  ) {
    return this.catalog.setActive(itemKey, dto.isActive);
  }
}

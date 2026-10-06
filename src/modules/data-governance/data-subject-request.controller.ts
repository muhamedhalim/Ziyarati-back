import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSION, ROLE } from '../../rbac/rbac.constants';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

import { DataSubjectRequestService } from './data-subject-request.service';
import {
  CloseDataSubjectRequestDto,
  CreateDataSubjectRequestDto,
  EraseSubjectDto,
  QueryDataSubjectRequestsDto,
} from './dto/data-subject-request.dto';

/**
 * Data-subject requests (residency plan P13): log a patient's request to see,
 * correct, restrict or delete their data, and fulfil it with an audit trail.
 *
 * OWNER / MANAGER only, on top of the CRM permission: erasing a patient is not a
 * front-desk action. A clinic must be able to honour a request even when its
 * subscription has lapsed, so this is `CORE_WORKSPACE` (always on), not a
 * togglable capability.
 *
 * Every call takes the tenant from the authenticated context — never from the
 * request — and the service re-checks that the patient belongs to it.
 */
@ApiTags('Privacy')
@ApiBearerAuth('JWT-auth')
@NoEntitlementRequired(FeatureKey.CORE_WORKSPACE)
@Controller('privacy/requests')
@UseGuards(RolesGuard, PermissionsGuard, ActiveTenantGuard)
@Roles(ROLE.OWNER, ROLE.MANAGER)
export class DataSubjectRequestController {
  constructor(
    private readonly requests: DataSubjectRequestService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Log a data-subject request',
    description:
      '**Protected — owner / manager with `crm.customers.manage`.** Records the request and its deadline (only if one is configured).',
  })
  @Post()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  create(
    @Body() dto: CreateDataSubjectRequestDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.requests.create(this.ctx.requireTenantId(), userId, dto);
  }

  @ApiOperation({
    summary: 'List data-subject requests',
    description: '**Protected — owner / manager with `crm.customers.read`.**',
  })
  @Get()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  list(@Query() query: QueryDataSubjectRequestsDto) {
    return this.requests.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get one data-subject request',
    description: '**Protected — owner / manager with `crm.customers.read`.**',
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.requests.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Fulfil an EXPORT request',
    description:
      "**Protected — owner / manager with `crm.customers.manage`.** Returns the patient's data as JSON and closes the request. " +
      'The read is recorded in the clinical read-audit.',
  })
  @Post(':id/export')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  export(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.requests.fulfilExport(this.ctx.requireTenantId(), userId, id);
  }

  @ApiOperation({
    summary: 'Fulfil a DELETION request',
    description:
      '**Protected — owner / manager with `crm.customers.manage`.** Anonymises the patient and removes derived data. ' +
      '`clinical` is REQUIRED: choose whether health / clinical records are retained or erased. ' +
      '`dryRun: true` reports exact counts and changes nothing. A real run writes deletion evidence; ' +
      'financial records and the read-audit trail are never erased by this endpoint.',
  })
  @Post(':id/erase')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  erase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EraseSubjectDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.requests.fulfilDeletion(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Fulfil a RESTRICTION request',
    description:
      '**Protected — owner / manager with `crm.customers.manage`.** Opts the patient out of ALL marketing. ' +
      'It does not stop operational processing; the outcome says so.',
  })
  @Post(':id/restrict')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  restrict(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.requests.fulfilRestriction(
      this.ctx.requireTenantId(),
      userId,
      id,
    );
  }

  @ApiOperation({
    summary: 'Close a request manually',
    description:
      '**Protected — owner / manager with `crm.customers.manage`.** For a CORRECTION (made through the normal customer edit) or a refusal.',
  })
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseDataSubjectRequestDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.requests.close(
      this.ctx.requireTenantId(),
      userId,
      id,
      dto.status,
      dto.note,
    );
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { WaitlistService } from './waitlist.service';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';
import { UpdateWaitlistEntryDto } from './dto/update-waitlist-entry.dto';
import { ListWaitlistEntriesQueryDto } from './dto/list-waitlist-entries-query.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 13 (US9, T161, contracts F9).
 * Reuses `appointments.read`/`appointments.manage_all` — no new permission
 * (a waitlist entry is just a deferred booking intent against the same
 * appointment resource).
 */
@ApiTags('Waitlist')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.APPOINTMENTS)
@Controller('waitlist')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class WaitlistController {
  constructor(
    private readonly waitlist: WaitlistService,
    private readonly ctx: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSION.APPOINTMENTS_READ)
  list(@Query() query: ListWaitlistEntriesQueryDto) {
    return this.waitlist.list(this.ctx.requireTenantId(), query);
  }

  @Post()
  @RequirePermissions(PERMISSION.APPOINTMENTS_MANAGE_ALL)
  create(@Body() dto: CreateWaitlistEntryDto) {
    return this.waitlist.create(this.ctx.requireTenantId(), dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSION.APPOINTMENTS_MANAGE_ALL)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWaitlistEntryDto,
  ) {
    return this.waitlist.update(this.ctx.requireTenantId(), id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSION.APPOINTMENTS_MANAGE_ALL)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.waitlist.cancel(this.ctx.requireTenantId(), id);
  }

  @Get(':id/offers')
  @RequirePermissions(PERMISSION.APPOINTMENTS_READ)
  offers(@Param('id', ParseUUIDPipe) id: string) {
    return this.waitlist.listOffers(this.ctx.requireTenantId(), id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CustomerSegmentService } from './customer-segment.service';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { PreviewSegmentDto } from './dto/preview-segment.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 10 (US8, T123, contracts F8).
 * No new permission — reuses `crm.customers.read`/`.manage`, matching the
 * fact that a segment is just a saved way of querying customers.
 */
@ApiTags('Customer Segments')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CRM)
@Controller('crm/segments')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerSegmentController {
  constructor(
    private readonly segments: CustomerSegmentService,
    private readonly ctx: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  list() {
    return this.segments.list(this.ctx.requireTenantId());
  }

  @Post()
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  create(@Body() dto: CreateSegmentDto) {
    return this.segments.create(
      this.ctx.requireTenantId(),
      this.requireActorId(),
      dto,
    );
  }

  @Patch(':id')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.segments.update(this.ctx.requireTenantId(), id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.segments.remove(this.ctx.requireTenantId(), id);
    return { id, deleted: true };
  }

  @Post('preview')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_READ)
  preview(@Body() dto: PreviewSegmentDto) {
    return this.segments.preview(
      this.ctx.requireTenantId(),
      dto.rules,
      dto.match,
    );
  }

  private requireActorId(): string {
    const user = this.ctx.getUser();
    if (!user?.id) {
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'Authenticated user required',
      });
    }
    return user.id;
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { TenantVerificationService } from './tenant-verification.service';
import { CreateVerificationDocumentDto } from './dto/create-verification-document.dto';
import { ReviewVerificationDocumentDto } from './dto/review-verification-document.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

/**
 * Verification documents.
 *  - `/me/...` : tenant owners submit & list THEIR OWN documents. Intentionally
 *    NOT behind ActiveTenantGuard — a pending/suspended tenant must be able to
 *    submit documents to get (re)approved. Scope comes from TenantContext.
 *  - admin routes: super-admin oversight & review.
 */
@Controller('verification-documents')
@UseGuards(RolesGuard)
export class TenantVerificationController {
  constructor(
    private readonly verification: TenantVerificationService,
    private readonly ctx: TenantContextService,
  ) {}

  @Post('me')
  @Roles(ROLE.OWNER)
  submit(@Body() dto: CreateVerificationDocumentDto) {
    return this.verification.submit(this.ctx.requireTenantId(), dto);
  }

  @Get('me')
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  listMine() {
    return this.verification.listForTenant(this.ctx.requireTenantId());
  }

  @Get('tenants/:tenantId')
  @Roles(ROLE.SUPER_ADMIN)
  listForTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.verification.listForTenant(tenantId);
  }

  @Patch(':documentId/review')
  @Roles(ROLE.SUPER_ADMIN)
  review(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser('id') reviewerId: string,
    @Body() dto: ReviewVerificationDocumentDto,
  ) {
    return this.verification.review(documentId, reviewerId, dto);
  }
}

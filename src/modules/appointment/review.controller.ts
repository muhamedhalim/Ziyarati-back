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
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AppointmentReviewService } from './appointment-review.service';
import { ReplyReviewDto } from './dto/reply-review.dto';
import { ListReviewsQueryDto } from './dto/list-reviews.query.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';

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

const S_REVIEW = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    rating: { type: 'number', example: 5 },
    comment: { type: 'string', nullable: true },
    reply: { type: 'string', nullable: true },
    customer: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
    appointment: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_REVIEW_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_REVIEW },
    total: { type: 'number', example: 87 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * Clinic-wide review management. Tenant-scoped via TenantContext; reviews from
 * other clinics are never visible.
 */
@ApiTags('Reviews')
@ApiBearerAuth('JWT-auth')
@Controller('reviews')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ReviewController {
  constructor(
    private readonly reviews: AppointmentReviewService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List customer reviews (filtered + paginated)',
    description: `
**Protected — requires \`reviews.read\`. Clinic must be active.**

Returns the clinic's customer reviews, newest first. Optional filters:
\`customerId\` and \`minRating\`.

**Who can call this:** Owner, Manager, Receptionist (\`reviews.read\`).

**Tenant scoping:** Only the caller's clinic reviews are returned.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated reviews.', schema: S_REVIEW_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `reviews.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.REVIEWS_READ)
  findAll(@Query() query: ListReviewsQueryDto) {
    return this.reviews.findAll(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Reply to a customer review',
    description: `
**Protected — requires \`reviews.manage\`. Clinic must be active.**

Adds (or replaces) the clinic's public reply to a customer review.

**Who can call this:** Owner or Manager (\`reviews.manage\`).

**Tenant scoping:** A review from another clinic returns 404.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Review UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Reply saved.', schema: S_REVIEW })
  @ApiBadRequestResponse({ description: 'Validation failed (empty reply).', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `reviews.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Review not found in this clinic.', schema: S_ERROR })
  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.REVIEWS_MANAGE)
  reply(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyReviewDto) {
    return this.reviews.reply(this.ctx.requireTenantId(), id, dto);
  }
}

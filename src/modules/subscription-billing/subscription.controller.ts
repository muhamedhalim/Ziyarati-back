import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { SubscriptionService } from './subscription.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';

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

const S_PLAN = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Professional' },
    price: { type: 'string', example: '299.00' },
    billing_cycle: {
      type: 'string',
      enum: ['MONTHLY', 'YEARLY', 'CUSTOM'],
      example: 'MONTHLY',
    },
    custom_cycle_value: { type: 'number', nullable: true, example: null },
    custom_cycle_unit: {
      type: 'string',
      enum: ['DAY', 'MONTH', 'YEAR'],
      nullable: true,
      example: null,
    },
    max_branches: { type: 'number', nullable: true, example: 5 },
    max_users: { type: 'number', nullable: true, example: 25 },
    max_ai_tokens: { type: 'string', nullable: true, example: '1000000' },
    max_whatsapp_messages: { type: 'number', nullable: true, example: 5000 },
    max_appointments: { type: 'number', nullable: true, example: 10000 },
    max_campaigns: { type: 'number', nullable: true, example: 50 },
    is_active: { type: 'boolean', example: true },
    is_custom: { type: 'boolean', example: false },
  },
};

const S_SUBSCRIPTION = {
  type: 'object',
  properties: {
    subscription: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: {
          type: 'string',
          enum: [
            'TRIAL',
            'ACTIVE',
            'PAST_DUE',
            'CANCELLED',
            'SUSPENDED',
            'GRACE_EXPIRED',
          ],
          example: 'ACTIVE',
        },
        starts_at: { type: 'string', format: 'date-time' },
        ends_at: { type: 'string', format: 'date-time' },
        grace_started_at: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          description:
            'FND-031: when PAST_DUE ("expired-in-grace") was entered.',
        },
        grace_expired_at: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          description: 'FND-031: when GRACE_EXPIRED was entered.',
        },
        auto_renew: { type: 'boolean', example: true },
        plan: S_PLAN,
      },
    },
    effectiveStatus: {
      type: 'string',
      enum: [
        'TRIAL',
        'ACTIVE',
        'PAST_DUE',
        'CANCELLED',
        'SUSPENDED',
        'GRACE_EXPIRED',
      ],
      example: 'ACTIVE',
      description:
        'Live-derived status: ACTIVE/TRIAL past ends_at reads as PAST_DUE; PAST_DUE whose grace window has elapsed reads as GRACE_EXPIRED — never a race against the background transition sweep.',
    },
    isUsable: {
      type: 'boolean',
      example: true,
      description:
        'Read access — true for every state except CANCELLED/SUSPENDED (FR-B007d).',
    },
    accessState: {
      type: 'string',
      enum: ['active', 'expired-in-grace', 'grace-expired', 'terminal'],
      example: 'active',
      description:
        'FND-031 — the three (plus terminal) access states named in the finding. Additive; never derive this from `status` client-side (LG-10).',
    },
    graceEndsAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description:
        'FND-031 — set only while accessState is "expired-in-grace"; when new billable/usage-increasing actions will start being refused.',
    },
  },
};

/**
 * Subscription lifecycle + plan catalogue.
 *
 * Guarded by PermissionsGuard (RBAC). ActiveTenantGuard is intentionally NOT
 * applied: these are account-level operations that must remain reachable so a
 * tenant can fix/restore its own billing. Tenant id comes from TenantContext.
 */
@ApiTags('Subscriptions')
@ApiBearerAuth('JWT-auth')
@Controller('subscriptions')
@UseGuards(PermissionsGuard)
export class SubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly ctx: TenantContextService,
  ) {}

  // ───────────────────────────── Plans ───────────────────────────────────── //

  @ApiOperation({
    summary: 'List available subscription plans',
    description: `
**Protected — requires \`subscription.read\`.**

Returns the active, global plan catalogue (price, billing cycle, limits and
feature caps) so the client can render a comparison/pricing table.

**Who can call this:** Owner, Manager (\`subscription.read\`). Plans are global
(not tenant-scoped) but only authenticated tenant users can browse them here.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Active plans.',
    schema: { type: 'array', items: S_PLAN },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `subscription.read`.',
    schema: S_ERROR,
  })
  @Get('plans')
  @RequirePermissions(PERMISSION.SUBSCRIPTION_READ)
  listPlans() {
    return this.subscriptions.listPlans();
  }

  @ApiOperation({
    summary: 'Get plan details (features & limits)',
    description: `
**Protected — requires \`subscription.read\`.**

Returns one plan with its full limit/feature set. Use for a plan detail or
comparison view.

**Who can call this:** Owner, Manager (\`subscription.read\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Plan UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Plan details.', schema: S_PLAN })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `subscription.read`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Plan not found.', schema: S_ERROR })
  @Get('plans/:id')
  @RequirePermissions(PERMISSION.SUBSCRIPTION_READ)
  getPlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptions.getPlan(id);
  }

  // ─────────────────────────── Subscription ──────────────────────────────── //

  @ApiOperation({
    summary: "Create a subscription for the caller's tenant",
    description: `
**Protected — requires \`subscription.manage\`.**

Subscribes the caller's tenant to a plan, computing \`starts_at\`/\`ends_at\`
from the plan's billing cycle. For non-trial subscriptions, the first
invoice is issued automatically (OPEN).

**Business rules**
- The plan must exist and be active (422 otherwise).
- One active subscription per tenant — a second attempt returns 409.

**Who can call this:** Owner (\`subscription.manage\`).

**Tenant scoping:** Always created for the caller's own tenant.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Subscription created.',
    schema: S_SUBSCRIPTION,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `subscription.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Plan not found.', schema: S_ERROR })
  @ApiConflictResponse({
    description: 'Tenant already has an active subscription.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Plan is inactive.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.SUBSCRIPTION_MANAGE)
  create(@Body() dto: CreateSubscriptionDto) {
    return this.subscriptions.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Get the current subscription status',
    description: `
**Protected — requires \`subscription.read\`.**

Returns the tenant's current subscription with its plan, plus a computed
\`effectiveStatus\` (adds the derived \`EXPIRED\` state when \`ends_at\` has
passed) and an \`isUsable\` flag the frontend can use to gate UI.

**Who can call this:** Owner, Manager (\`subscription.read\`).

**Tenant scoping:** Always the caller's own subscription.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Current subscription.',
    schema: S_SUBSCRIPTION,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `subscription.read`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'No subscription found for this tenant.',
    schema: S_ERROR,
  })
  @Get('current')
  @RequirePermissions(PERMISSION.SUBSCRIPTION_READ)
  getCurrent() {
    return this.subscriptions.getCurrent(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Upgrade or downgrade the plan',
    description: `
**Protected — requires \`subscription.manage\`.**

Switches the current subscription to a different active plan. Direction
(upgrade/downgrade) is implied by price; proration is abstracted — an
invoice for the new plan price is issued.

**Business rules:** target plan must exist, be active, and differ from the
current plan (409 if same).

**Who can call this:** Owner (\`subscription.manage\`).
    `.trim(),
  })
  @ApiOkResponse({ description: 'Plan changed.', schema: S_SUBSCRIPTION })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `subscription.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'No active subscription, or target plan not found.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Already on the requested plan.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Target plan is inactive.',
    schema: S_ERROR,
  })
  @Post('change-plan')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SUBSCRIPTION_MANAGE)
  changePlan(@Body() dto: ChangePlanDto) {
    return this.subscriptions.changePlan(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Cancel the subscription',
    description: `
**Protected — requires \`subscription.manage\`.**

Cancels the subscription. With \`cancelAtPeriodEnd=true\`, access is kept
until \`ends_at\` and only auto-renew is switched off; otherwise it is
cancelled immediately (status → CANCELLED).

Schema note: \`reason\` is accepted for audit logging only (no column to
persist it).

**Who can call this:** Owner (\`subscription.manage\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Subscription cancelled.',
    schema: S_SUBSCRIPTION,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `subscription.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'No active subscription found.',
    schema: S_ERROR,
  })
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SUBSCRIPTION_MANAGE)
  cancel(@Body() dto: CancelSubscriptionDto) {
    return this.subscriptions.cancel(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Reactivate a cancelled / past-due subscription',
    description: `
**Protected — requires \`subscription.manage\`.**

Returns a cancelled or past-due subscription to ACTIVE and re-enables
auto-renew. If the period had already lapsed, a fresh period is started
from now using the plan's billing cycle.

**Business rules:** 409 if already active.

**Who can call this:** Owner (\`subscription.manage\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Subscription reactivated.',
    schema: S_SUBSCRIPTION,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `subscription.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'No subscription found for this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Subscription is already active.',
    schema: S_ERROR,
  })
  @Post('reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SUBSCRIPTION_MANAGE)
  reactivate() {
    return this.subscriptions.reactivate(this.ctx.requireTenantId());
  }
}

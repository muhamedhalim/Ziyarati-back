import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { BillingModeService } from './billing-mode.service';
import { BillingService } from './billing.service';
import { SubscriptionInvoiceRefundService } from './subscription-invoice-refund.service';
import { RefundInvoiceDto } from './dto/refund-invoice.dto';
import { FreeAccessOverrideService } from './free-access-override.service';
import { PlanAdminService } from './plan-admin.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/upsert-plan.dto';
import { GrantOverrideDto, ExtendOverrideDto } from './dto/grant-override.dto';
import { SetBillingModeDto } from './dto/set-billing-mode.dto';
import { ListFreeAccessOverviewQueryDto } from './dto/list-free-access-overview.query.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

/**
 * PLATFORM-ONLY billing control plane (super admin).
 *
 * Per the business rule, ALL billing CONTROL — plan creation/editing/activation,
 * the global free/paid mode switch, and free-access overrides — is restricted to
 * the super admin (RolesGuard + @Roles(super_admin); super_admin holds the `*`
 * permission wildcard). Tenants only consume billing (browse plans, subscribe,
 * view their own invoices) via the tenant-scoped controllers.
 */
@ApiTags('Platform Billing (Super Admin)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/billing')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformBillingAdminController {
  constructor(
    private readonly mode: BillingModeService,
    private readonly overrides: FreeAccessOverrideService,
    private readonly plans: PlanAdminService,
    private readonly billing: BillingService,
    private readonly invoiceRefunds: SubscriptionInvoiceRefundService,
    private readonly ctx: TenantContextService,
  ) {}

  // ─────────────────────────── Global billing mode ────────────────────────── //

  @ApiOperation({ summary: 'Get the global platform billing mode' })
  @ApiOkResponse({ description: 'Current mode (free | paid).' })
  @Get('mode')
  async getMode() {
    return { mode: await this.mode.get() };
  }

  @ApiOperation({
    summary: 'Switch the global platform billing mode (free ↔ paid)',
    description:
      'Runtime switch. `free` opens the platform to everyone (enforcement off); `paid` requires a usable subscription (or override). Existing subscriptions/usage are untouched.',
  })
  @ApiOkResponse({ description: 'Mode updated.' })
  @Put('mode')
  @HttpCode(HttpStatus.OK)
  setMode(@Body() dto: SetBillingModeDto) {
    return this.mode.set(dto.mode);
  }

  // ──────────────────────────────── Plans ─────────────────────────────────── //

  @ApiOperation({ summary: 'List all plans (incl. inactive)' })
  @ApiOkResponse({ description: 'Full plan catalogue.' })
  @Get('plans')
  listPlans() {
    return this.plans.listAll();
  }

  @ApiOperation({ summary: 'Create a subscription plan' })
  @ApiOkResponse({ description: 'Plan created.' })
  @Post('plans')
  createPlan(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @ApiOperation({ summary: 'Get a plan (admin view)' })
  @ApiOkResponse({
    description: 'Plan, including whether it has active subscribers.',
  })
  @Get('plans/:id')
  getPlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.getAdminView(id);
  }

  @ApiOperation({
    summary: 'Update a plan',
    description:
      'Name/active state are always editable. Pricing/cycle/limits are immutable once the plan has active subscribers (422) — create a new plan instead so existing subscriptions keep their terms.',
  })
  @ApiOkResponse({ description: 'Plan updated.' })
  @Patch('plans/:id')
  updatePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.plans.update(id, dto);
  }

  @ApiOperation({ summary: 'Activate a plan (show in catalogue)' })
  @ApiOkResponse({ description: 'Plan activated.' })
  @Post('plans/:id/activate')
  @HttpCode(HttpStatus.OK)
  activatePlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.setActive(id, true);
  }

  @ApiOperation({
    summary: 'Deactivate a plan',
    description:
      'Hides the plan from the catalogue. Existing subscribers are unaffected.',
  })
  @ApiOkResponse({ description: 'Plan deactivated.' })
  @Post('plans/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivatePlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.setActive(id, false);
  }

  // ─────────────────────────── Free-access overrides ──────────────────────── //

  @ApiOperation({
    summary: "Get a tenant's active free-access override and lifecycle summary",
    description:
      '`override` is the tenant\'s currently ACTIVE, time-valid override (null ' +
      "if none). `summary` is the tenant's overall free-access lifecycle — the " +
      'latest override of ANY status (so a just-expired or just-revoked one ' +
      'still shows), with server-computed elapsed/remaining days and notice ' +
      "delivery status. `summary.lifecycle` is `NONE` if the tenant has never " +
      'had an override.',
  })
  @ApiOkResponse({ description: 'Active override (or null) and lifecycle summary.' })
  @Get('tenants/:tenantId/override')
  async getOverride(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    const [override, summary] = await Promise.all([
      this.overrides.getActive(tenantId),
      this.overrides.getSummary(tenantId),
    ]);
    return { override, summary };
  }

  @ApiOperation({
    summary: 'Cross-clinic free-access lifecycle overview (for the admin table)',
    description:
      'One paginated, searchable, lifecycle-filtered listing across every ' +
      'clinic — every tenant appears, even one that has never had an ' +
      'override (`lifecycle: NONE`). Powers the overview table on ' +
      '`/platform/feature-flags` without an N+1 query per clinic.',
  })
  @ApiOkResponse({
    description: 'A page of free-access lifecycle summaries plus the server clock.',
  })
  @Get('overview')
  listOverview(@Query() query: ListFreeAccessOverviewQueryDto) {
    return this.overrides.listOverview(query);
  }

  @ApiOperation({ summary: "Get a tenant's override history" })
  @ApiOkResponse({ description: 'Override history (newest first).' })
  @Get('tenants/:tenantId/override/history')
  overrideHistory(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.overrides.listForTenant(tenantId);
  }

  @ApiOperation({
    summary: 'Grant a free-access override to a tenant',
    description:
      'Gives the tenant free access regardless of subscription, for `durationDays` (1–365) ' +
      'whole days; omit it for unlimited. The CLIENT NEVER SENDS AN EXPIRY: both `starts_at` ' +
      'and `ends_at` are computed from the database clock inside one statement, so the stored ' +
      'grant is exactly `starts_at + durationDays`. Expiry is then evaluated on every access ' +
      'check (`ends_at > now()`), never by a scheduled job. 409 if the tenant already has an ' +
      'active override — extend or revoke that one instead; concurrent grants are serialized ' +
      'so exactly one wins.',
  })
  @ApiOkResponse({ description: 'Override granted.' })
  @Post('tenants/:tenantId/override')
  grantOverride(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: GrantOverrideDto,
  ) {
    return this.overrides.grant(tenantId, {
      grantedBy: this.ctx.getUser()?.id,
      reason: dto.reason,
      durationDays: dto.durationDays ?? null,
      // Only an admin-initiated HTTP grant notifies the clinic (D4) — every
      // other caller of `grant()` (guest-discovery tenant creation, seeds)
      // defaults to silent.
      notifyClinic: true,
    });
  }

  @ApiOperation({
    summary: "Extend (or make unlimited) a tenant's active override",
  })
  @ApiOkResponse({ description: 'Override extended.' })
  @Patch('tenants/:tenantId/override')
  extendOverride(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: ExtendOverrideDto,
  ) {
    return this.overrides.extend(tenantId, dto.durationDays ?? null);
  }

  @ApiOperation({ summary: "Revoke a tenant's active free-access override" })
  @ApiOkResponse({ description: 'Override revoked.' })
  @Post('tenants/:tenantId/override/revoke')
  @HttpCode(HttpStatus.OK)
  revokeOverride(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.overrides.revoke(tenantId);
  }

  // ──────────────────────────── Renewals (T089) ────────────────────────── //

  @ApiOperation({
    summary: 'List renewals blocked specifically on provider tokenization',
    description:
      'FR-B005e — every OPEN subscription invoice whose last decline is ' +
      'classified TOKENIZATION_UNAVAILABLE, distinguishable from an ordinary ' +
      'card decline, so the operational backlog stays visible per clinic ' +
      'rather than silently accumulating in the past-due state.',
  })
  @ApiOkResponse({ description: 'Affected clinics with their retry state.' })
  @Get('renewals/tokenization-declines')
  listTokenizationDeclines() {
    return this.billing.listTokenizationDeclines();
  }

  // ─────────────────────────── Subscription invoice refund ─────────────────────────── //

  @ApiOperation({
    summary: 'Refund a paid subscription invoice (full amount)',
    description:
      'Platform-only. The platform refunds a subscription payment it collected: the invoice moves PAID → REFUNDED once the provider confirms. The refund may be asynchronous: a **pending** result means the provider accepted it but has not completed it — the webhook or the sweep finishes it, and repeating this call never starts a second refund. The subscription itself is not changed.',
  })
  @ApiOkResponse({ description: '{ status: "refunded" | "pending", invoice }.' })
  @Post('invoices/:id/refund')
  @HttpCode(HttpStatus.OK)
  refundInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundInvoiceDto,
  ) {
    return this.invoiceRefunds.request(id, this.ctx.getUser()?.id, dto.reason);
  }
}

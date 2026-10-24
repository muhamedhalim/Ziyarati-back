import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { BillingService } from './billing.service';
import { SubscriptionCheckoutService } from './subscription-checkout.service';
import { PaymentMethodService } from './payment-method.service';
import { BILLING_CHECKOUT_THROTTLE } from './billing-checkout.constants';
import { QueryInvoicesDto } from './dto/query-invoices.dto';
import { VerifyCheckoutDto } from './dto/verify-checkout.dto';

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

const S_INVOICE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenant_id: { type: 'string', format: 'uuid' },
    subscription_id: { type: 'string', format: 'uuid' },
    amount: { type: 'string', example: '299.00' },
    status: {
      type: 'string',
      enum: ['DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE', 'REFUNDED'],
      example: 'OPEN',
    },
    issued_at: { type: 'string', format: 'date-time', nullable: true },
    paid_at: { type: 'string', format: 'date-time', nullable: true },
    period_start: { type: 'string', format: 'date-time' },
    period_end: { type: 'string', format: 'date-time' },
    currency: { type: 'string', example: 'SAR' },
    retry_count: { type: 'number', example: 0 },
    next_retry_at: { type: 'string', format: 'date-time', nullable: true },
    failure_reason: { type: 'string', nullable: true },
    failure_class: {
      type: 'string',
      nullable: true,
      example: 'TOKENIZATION_UNAVAILABLE',
    },
    kind: {
      type: 'string',
      enum: ['INITIAL', 'UPGRADE', 'RENEWAL', 'REACTIVATION'],
      nullable: true,
      description:
        'What the invoice buys. Null on an invoice issued before this field existed.',
      example: 'RENEWAL',
    },
    provider: {
      type: 'string',
      nullable: true,
      description: 'Payment gateway that settled (or is settling) it.',
      example: 'tap',
    },
  },
};

const S_INVOICE_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_INVOICE },
    total: { type: 'number', example: 12 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

const S_SUMMARY = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    totalInvoices: { type: 'number', example: 12 },
    totalPaid: { type: 'number', example: 3588.0 },
    totalOutstanding: { type: 'number', example: 299.0 },
    byStatus: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { count: { type: 'number' }, total: { type: 'number' } },
      },
    },
  },
};

/**
 * Billing & invoices. Guarded by PermissionsGuard. Tenant id from TenantContext;
 * invoices are isolated by their `tenant_id` column.
 */
@ApiTags('Billing')
@ApiBearerAuth('JWT-auth')
@Controller('billing')
@UseGuards(PermissionsGuard)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly checkout: SubscriptionCheckoutService,
    private readonly paymentMethods: PaymentMethodService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List invoices (history)',
    description: `
**Protected — requires \`billing.read\`.**

Returns the tenant's invoice history, newest first, with optional status and
issued-date filters and pagination.

**Who can call this:** Owner, Manager (\`billing.read\`).

**Tenant scoping:** Filtered by \`tenant_id\` — only the caller's invoices.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated invoices.', schema: S_INVOICE_LIST })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.read`.',
    schema: S_ERROR,
  })
  @Get('invoices')
  @RequirePermissions(PERMISSION.BILLING_READ)
  listInvoices(@Query() query: QueryInvoicesDto) {
    return this.billing.listInvoices(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get billing summary',
    description: `
**Protected — requires \`billing.read\`.**

Aggregated overview of the tenant's invoices: total count, total paid, total
outstanding (DRAFT/OPEN), and a per-status breakdown. Powers the billing
dashboard widget.

**Who can call this:** Owner, Manager (\`billing.read\`).
    `.trim(),
  })
  @ApiOkResponse({ description: 'Billing summary.', schema: S_SUMMARY })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.read`.',
    schema: S_ERROR,
  })
  @Get('summary')
  @RequirePermissions(PERMISSION.BILLING_READ)
  summary() {
    return this.billing.getSummary(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Get invoice details',
    description: `
**Protected — requires \`billing.read\`.**

Returns a single invoice. An invoice belonging to another tenant returns
404 (no cross-tenant leak).

**Who can call this:** Owner, Manager (\`billing.read\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Invoice details.', schema: S_INVOICE })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.read`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @Get('invoices/:id')
  @RequirePermissions(PERMISSION.BILLING_READ)
  getInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.getInvoice(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Pay an invoice',
    description: `
**Protected — requires \`billing.manage\`.**

Settles an open invoice through the **payment-provider abstraction** (no
gateway SDK is referenced in the domain). On a successful charge the invoice
is marked PAID; on a decline it stays unpaid and returns 422.

**Failure scenarios**
- Already paid → 409.
- VOID/REFUNDED → 422 (cannot be paid).
- Provider declines → 422.

**Who can call this:** Owner (\`billing.manage\`).

**Tenant scoping:** Only the caller's own invoices are payable.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Invoice paid.', schema: S_INVOICE })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Invoice already paid.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Invoice not payable, or payment declined.',
    schema: S_ERROR,
  })
  @Throttle(BILLING_CHECKOUT_THROTTLE) // FIN-S6: each call is a provider charge attempt
  @Post('invoices/:id/pay')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.BILLING_MANAGE)
  payInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.payInvoice(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Open (or resume) the hosted checkout for an invoice',
    description: `
**Protected — requires \`billing.manage\`.**

Opens the payment provider's hosted page for an unpaid invoice — the way a
clinic pays its first subscription invoice, an upgrade, or a renewal it was
asked to pay by hand. The card is entered ONLY on the provider's page; nothing
card-related ever reaches this API.

Returns \`{ status: 'redirect', redirectUrl }\` — send the browser there — or
\`{ status: 'paid' }\` when the invoice turned out to be paid already. A
checkout that is still open is RESUMED, never duplicated. The clinic comes
back to \`/app/billing?checkout=return\`; the subscription activates when the
payment is confirmed (return page, webhook or reconciliation — whichever
lands first, exactly once).

**Failure scenarios**
- Already paid → 409. VOID/REFUNDED → 422.
- Subscription cancelled/suspended → 409 (nothing to apply a payment to).
- Another payment for the invoice is in progress → 409.
- Online payment not available / provider down → 422 / 503.

**Who can call this:** Owner (\`billing.manage\`).

**Tenant scoping:** Only the caller's own invoices; another tenant's → 404.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Checkout opened (or invoice already paid).',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['redirect', 'paid'] },
        invoiceId: { type: 'string', format: 'uuid' },
        redirectUrl: {
          type: 'string',
          description: 'Present when status is "redirect".',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Invoice already paid, or a payment is already in progress.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Invoice not payable, or online payment unavailable.',
    schema: S_ERROR,
  })
  @Throttle(BILLING_CHECKOUT_THROTTLE)
  @Post('invoices/:id/checkout')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.BILLING_MANAGE)
  openCheckout(@Param('id', ParseUUIDPipe) id: string) {
    return this.checkout.createCheckout(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Verify a hosted checkout after the clinic returns',
    description: `
**Protected — requires \`billing.manage\`.**

Called by the return page with the provider's charge id (\`tap_id\`). The
server asks the provider about that charge ITSELF — the client's word is never
trusted — and, if it is captured for the invoice's exact amount, settles the
invoice and activates / switches the subscription. Safe to call repeatedly and
alongside the webhook: it settles at most once.

Returns \`{ status, invoiceId, subscriptionStatus }\`. \`status\` is \`paid\`,
\`pending\` (keep polling), \`failed\`, or \`unknown\` (provider unreachable —
check again shortly).

**Tenant scoping:** a charge that is not one of the caller's own invoice
charges — including another clinic's — is a plain 404.

**Who can call this:** Owner (\`billing.manage\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Verification result.',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['paid', 'pending', 'failed', 'unknown'],
        },
        invoiceId: { type: 'string', format: 'uuid' },
        subscriptionStatus: { type: 'string', example: 'ACTIVE' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: "Charge is not one of this tenant's invoice charges.",
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'The captured payment could not be applied to the invoice.',
    schema: S_ERROR,
  })
  @Throttle(BILLING_CHECKOUT_THROTTLE)
  @Post('checkout/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.BILLING_MANAGE)
  verifyCheckout(@Body() dto: VerifyCheckoutDto) {
    return this.checkout.verifyCheckout(
      this.ctx.requireTenantId(),
      dto.chargeId,
    );
  }

  @ApiOperation({
    summary: "Get the clinic's saved payment method",
    description: `
**Protected — requires \`billing.read\`.**

The card saved at the last checkout (brand, scheme, last four digits) — never
the provider's ids. \`recurringCapable: false\` means renewals cannot charge it
without the clinic present, so each renewal must be paid by hand.

**Who can call this:** Owner, Manager (\`billing.read\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'The default saved card, or null.',
    schema: {
      type: 'object',
      properties: {
        paymentMethod: {
          type: 'object',
          nullable: true,
          properties: {
            id: { type: 'string', format: 'uuid' },
            provider: { type: 'string', example: 'tap' },
            brand: { type: 'string', nullable: true, example: 'VISA' },
            scheme: { type: 'string', nullable: true, example: 'VISA' },
            lastFour: { type: 'string', nullable: true, example: '1019' },
            recurringCapable: { type: 'boolean' },
            isDefault: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        checkoutAvailable: {
          type: 'boolean',
          description: 'Whether online payment is available at all.',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.read`.',
    schema: S_ERROR,
  })
  @Get('payment-method')
  @RequirePermissions(PERMISSION.BILLING_READ)
  async getPaymentMethod() {
    const paymentMethod = await this.paymentMethods.getDefault(
      this.ctx.requireTenantId(),
    );
    return { paymentMethod, checkoutAvailable: this.billing.supportsCheckout };
  }

  @ApiOperation({
    summary: "Remove the clinic's saved payment method",
    description: `
**Protected — requires \`billing.manage\`.**

Revokes the saved card (it can never be charged again) and deletes it at the
provider. The next renewal then asks the clinic to pay by hand; paying through
checkout saves a new card. To REPLACE a card, simply pay the next invoice with
the new one — the most recently saved card becomes the default.

**Who can call this:** Owner (\`billing.manage\`).

**Tenant scoping:** Only the caller's own cards; another tenant's → 404.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Payment method UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Removed.',
    schema: {
      type: 'object',
      properties: { removed: { type: 'boolean', example: true } },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `billing.manage`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Payment method not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete('payment-method/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.BILLING_MANAGE)
  async removePaymentMethod(@Param('id', ParseUUIDPipe) id: string) {
    await this.paymentMethods.remove(this.ctx.requireTenantId(), id);
    return { removed: true };
  }
}

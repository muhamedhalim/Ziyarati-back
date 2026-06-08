import {
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
import { QueryInvoicesDto } from './dto/query-invoices.dto';

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
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `billing.read`.', schema: S_ERROR })
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
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `billing.read`.', schema: S_ERROR })
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
  @ApiParam({ name: 'id', description: 'Invoice UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Invoice details.', schema: S_INVOICE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `billing.read`.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Invoice not found in this tenant.', schema: S_ERROR })
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
  @ApiParam({ name: 'id', description: 'Invoice UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Invoice paid.', schema: S_INVOICE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `billing.manage`.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Invoice not found in this tenant.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Invoice already paid.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Invoice not payable, or payment declined.', schema: S_ERROR })
  @Post('invoices/:id/pay')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.BILLING_MANAGE)
  payInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.payInvoice(this.ctx.requireTenantId(), id);
  }
}

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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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

import { InvoiceService } from './invoice.service';
import {
  InvoiceAuditService,
  INVOICE_AUDIT_ACTION,
} from './invoice-audit.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { AddInvoiceItemsDto } from './dto/add-invoice-item.dto';
import { QueryInvoicesDto } from './dto/query-invoices.dto';
import { StorageService } from '../storage/storage.service';
import { AppError, ErrorCode } from '../../common/errors';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

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

/**
 * Invoices (clinic → customer). Guarded by PermissionsGuard + ActiveTenantGuard;
 * tenant id from TenantContext. Numbers are tenant-scoped; totals auto-calculated.
 */
@ApiTags('Invoices')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.PAYMENTS)
@Controller('invoices')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class InvoiceController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly ctx: TenantContextService,
    private readonly storage: StorageService,
    private readonly audit: InvoiceAuditService,
  ) {}

  @ApiOperation({
    summary: 'Create an invoice (DRAFT)',
    description:
      '**Protected — `invoices.manage`. Clinic active.** Creates a DRAFT invoice with a tenant-scoped number. Optional initial line items are accepted; the total is auto-calculated.',
  })
  @ApiCreatedResponse({ description: 'Invoice created (with items).' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `invoices.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.INVOICES_MANAGE)
  create(@Body() dto: CreateInvoiceDto) {
    return this.invoices.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Add line items to a DRAFT invoice',
    description:
      '**Protected — `invoices.manage`. Clinic active.** Appends items and recomputes the total. Only DRAFT invoices can be modified (422 otherwise).',
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Items added; invoice with new total.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `invoices.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Invoice is not DRAFT.',
    schema: S_ERROR,
  })
  @Post(':id/items')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.INVOICES_MANAGE)
  addItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddInvoiceItemsDto,
  ) {
    return this.invoices.addItems(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Finalize an invoice (DRAFT → OPEN)',
    description:
      '**Protected — `invoices.manage`. Clinic active.** Issues the invoice (stamps `issued_at`). 409 if it is no longer DRAFT.',
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Invoice finalized (OPEN).' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `invoices.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Invoice already finalized.',
    schema: S_ERROR,
  })
  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.INVOICES_MANAGE)
  finalize(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.finalize(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'List invoices',
    description:
      '**Protected — `invoices.read`. Clinic active.** Tenant-scoped, newest first, with status/customer/date filters and pagination.',
  })
  @ApiOkResponse({ description: 'Paginated invoices.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `invoices.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.INVOICES_READ)
  list(@Query() query: QueryInvoicesDto) {
    return this.invoices.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get invoice details (with items)',
    description:
      "**Protected — `invoices.read`. Clinic active.** Returns the invoice and its line items. Another tenant's invoice returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Invoice with items.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `invoices.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.INVOICES_READ)
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.getOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Get the invoice document (PDF)',
    description:
      '**Protected — `invoices.read`. Clinic active.** T096 (FR-I001, FR-I007, FR-I009, FR-I012). ' +
      '200 with a short-lived signed URL once rendered; 202 while a render is pending; 409 for a ' +
      "DRAFT invoice — nothing to download yet. Another tenant's invoice is a 404, indistinguishable " +
      'from one that does not exist (FR-I008). Recorded to the audit trail (FR-I014).',
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Signed download URL for the rendered document.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `invoices.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Invoice is DRAFT — no document to download.',
    schema: S_ERROR,
  })
  @Get(':id/document')
  @RequirePermissions(PERMISSION.INVOICES_READ)
  async getDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const state = await this.invoices.getDocumentState(tenantId, id);

    if (state.state === 'draft') {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A draft invoice has no document to download',
      });
    }
    if (state.state === 'pending') {
      res.status(HttpStatus.ACCEPTED);
      return { status: 'pending' };
    }

    const url = await this.storage.getSignedDownloadUrl(
      state.documentKey,
      tenantId,
    );
    await this.audit.record(
      INVOICE_AUDIT_ACTION.DOCUMENT_DOWNLOADED,
      tenantId,
      id,
      this.ctx.getUser()?.id,
    );
    return { status: 'ready', url };
  }

  @ApiOperation({
    summary: 'Regenerate the invoice document',
    description:
      '**Protected — `invoices.manage`. Clinic active.** T096 (FR-I010) — forces a fresh render, ' +
      "e.g. after the invoice's payment state changed. 409 for a DRAFT invoice.",
  })
  @ApiParam({
    name: 'id',
    description: 'Invoice UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Regeneration triggered.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `invoices.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Invoice not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Invoice is DRAFT — nothing to regenerate.',
    schema: S_ERROR,
  })
  @Post(':id/document/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PERMISSION.INVOICES_MANAGE)
  async regenerateDocument(@Param('id', ParseUUIDPipe) id: string) {
    await this.invoices.regenerateDocument(this.ctx.requireTenantId(), id);
    return { status: 'pending' };
  }
}

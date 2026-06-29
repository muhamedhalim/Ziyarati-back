import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { TenantVerificationService } from './tenant-verification.service';
import { CreateVerificationDocumentDto } from './dto/create-verification-document.dto';
import { ReviewVerificationDocumentDto } from './dto/review-verification-document.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

// ─── Reusable inline response schema fragments ────────────────────────────────

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

const S_DOCUMENT_DETAIL = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    docType: {
      type: 'string',
      example: 'commercial_registration',
      description:
        'Document category. Common values: `commercial_registration`, `national_id`, `license`, `vat_certificate`.',
    },
    fileUrl: {
      type: 'string',
      example: 'https://storage.example.com/docs/cr-1010123456.pdf',
      description: 'URL of the already-uploaded file. Upload is handled by the storage layer before calling this endpoint.',
    },
    status: {
      type: 'string',
      enum: ['pending', 'approved', 'rejected'],
      example: 'pending',
    },
    reviewNote: {
      type: 'string',
      nullable: true,
      example: 'Document is blurry — please re-upload a clearer scan.',
    },
    reviewedById: { type: 'string', format: 'uuid', nullable: true },
    reviewedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verification documents.
 *  - `/me/...` : tenant owners submit & list THEIR OWN documents. Intentionally
 *    NOT behind ActiveTenantGuard — a pending/suspended tenant must be able to
 *    submit documents to get (re)approved. Scope comes from TenantContext.
 *  - admin routes: super-admin oversight & review.
 */
@ApiTags('Verification Documents')
@Controller('verification-documents')
@UseGuards(RolesGuard)
@ApiBearerAuth('JWT-auth')
export class TenantVerificationController {
  constructor(
    private readonly verification: TenantVerificationService,
    private readonly ctx: TenantContextService,
  ) {}

  /** Builds the request-derived audit actor (id, primary role, IP, user agent). */
  private actor(id: string, ip: string, userAgent: string) {
    return {
      id,
      role: this.ctx.getUser()?.roles?.[0],
      ip,
      userAgent,
    };
  }

  // ────────────────────── Tenant self-service (owner) ────────────────────── //

  @ApiOperation({
    summary: 'Submit a verification document (owner self-service)',
    description: `
**Protected — \`owner\` role required.**

Submits a verification document for the caller's clinic. Documents are
used by the platform team to verify the clinic's legal identity before
approval.

**Important: File upload is a separate step.** Upload the file to your
storage provider (S3 / CDN) first, then pass the resulting URL in the
\`fileUrl\` field. This endpoint only records the document metadata.

**This endpoint intentionally does NOT require the tenant to be active**
(no \`ActiveTenantGuard\`). Clinics with \`pending\` or \`suspended\` status
must be able to submit documents in order to be (re)approved by the
platform.

**Common \`docType\` values:**
- \`commercial_registration\` — Business registration certificate
- \`national_id\` — Owner national ID
- \`license\` — Ministry of Health license
- \`vat_certificate\` — VAT registration

**Who can call this:** Clinic Owner only.

**Tenant scoping:** Always submits for the caller's own clinic.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Document submitted. Status is `pending` until reviewed by a super-admin.',
    schema: S_DOCUMENT_DETAIL,
  })
  @ApiBadRequestResponse({
    description: 'Validation failed — `docType` or `fileUrl` is missing or too long.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller is not the clinic `owner`.',
    schema: S_ERROR,
  })
  @Post('me')
  @Roles(ROLE.OWNER)
  submit(
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Body() dto: CreateVerificationDocumentDto,
  ) {
    return this.verification.submit(
      this.ctx.requireTenantId(),
      this.actor(userId, ip, userAgent),
      dto,
    );
  }

  @ApiOperation({
    summary: 'Submit verification for review (owner)',
    description: `
**Protected — \`owner\` role required.**

Finalises document submission. The backend validates that **every required
document type** has been uploaded; if any are missing it returns **400** with the
exact missing types and does NOT advance the clinic. On success the clinic moves
to \`PENDING_APPROVAL\` and platform admins are notified.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Clinic advanced to PENDING_APPROVAL.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'PENDING_APPROVAL' },
        missing: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Required documents are missing — see `context.missing`.',
    schema: S_ERROR,
  })
  @Post('me/submit')
  @Roles(ROLE.OWNER)
  submitForReview(
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.verification.submitForReview(
      this.ctx.requireTenantId(),
      this.actor(userId, ip, userAgent),
    );
  }

  @ApiOperation({
    summary: 'Get a viewable URL for a verification document',
    description: `
**Protected — \`owner\`/\`manager\` (own clinic) or \`super_admin\` (any).**

Returns a short-lived signed URL for the document's file. Private R2 objects
yield a presigned GET that expires in ~5 minutes; legacy externally-hosted
documents return their stored URL. The bucket is never public, so clients must
call this each time they need to view a file.
    `.trim(),
  })
  @ApiParam({ name: 'documentId', description: 'UUID of the document', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'A viewable URL (presigned for private objects).',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        expiresIn: { type: 'number', nullable: true, example: 300 },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks access to this document.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Document not found.', schema: S_ERROR })
  @Get(':documentId/file-url')
  @Roles(ROLE.OWNER, ROLE.MANAGER, ROLE.SUPER_ADMIN)
  getFileUrl(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const scope = this.ctx.isSuperAdmin() ? null : this.ctx.requireTenantId();
    return this.verification.getFileUrl(
      documentId,
      scope,
      this.actor(userId, ip, userAgent),
    );
  }

  @ApiOperation({
    summary: 'List my clinic\'s verification documents (owner self-service)',
    description: `
**Protected — \`owner\` or \`manager\` role required.**

Returns all verification documents submitted by the caller's clinic,
including their current review status and any notes left by the
platform reviewer.

Useful for the clinic owner to track which documents are still pending
review, which were approved, and which were rejected (and why).

**This endpoint intentionally does NOT require the tenant to be active.**
Clinics with \`pending\` or \`suspended\` status need to see the document
review status to understand what action is required.

**Who can call this:** Clinic Owner or Manager.

**Tenant scoping:** Returns only documents belonging to the caller's clinic.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'All verification documents for the caller\'s clinic.',
    schema: { type: 'array', items: S_DOCUMENT_DETAIL },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller is not `owner` or `manager`.',
    schema: S_ERROR,
  })
  @Get('me')
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  listMine() {
    return this.verification.listForTenant(this.ctx.requireTenantId());
  }

  // ─────────────────────────── Platform admin ────────────────────────────── //

  @ApiOperation({
    summary: 'List all verification documents for a tenant (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Returns all verification documents submitted by any tenant, identified
by their UUID. Used by the platform compliance team during the tenant
review and approval workflow.

Typically called after navigating to a specific tenant's detail page
in the admin dashboard.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({ name: 'tenantId', description: 'UUID of the tenant to inspect', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'All verification documents for the specified tenant.',
    schema: { type: 'array', items: S_DOCUMENT_DETAIL },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not `super_admin`.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Tenant not found.', schema: S_ERROR })
  @Get('tenants/:tenantId')
  @Roles(ROLE.SUPER_ADMIN)
  listForTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.verification.listForTenant(tenantId);
  }

  @ApiOperation({
    summary: 'Verification audit trail for a tenant (platform admin)',
    description:
      '**Protected — `super_admin` role required.** Returns the immutable audit log (uploaded / replaced / deleted / viewed / approved / rejected / submitted) for a tenant, newest first, with actor, IP and user agent.',
  })
  @ApiParam({ name: 'tenantId', description: 'UUID of the tenant', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Audit entries, newest first.' })
  @ApiForbiddenResponse({ description: 'Caller is not `super_admin`.', schema: S_ERROR })
  @Get('tenants/:tenantId/audit')
  @Roles(ROLE.SUPER_ADMIN)
  listAudit(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit ? Number(limit) : undefined;
    return this.verification.listAudit(
      tenantId,
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    );
  }

  @ApiOperation({
    summary: 'Approve or reject a verification document (platform admin)',
    description: `
**Protected — \`super_admin\` role required.**

Records the platform reviewer's decision on a submitted document.

**Status values:**
- \`approved\` — Document is valid. If all required documents are
  approved, the platform admin can proceed to approve the tenant via
  \`POST /tenants/:id/approve\`.
- \`rejected\` — Document is invalid or insufficient. Include a
  \`reviewNote\` explaining what is wrong so the clinic owner can
  re-submit the correct document.

**Side effects:**
- The document's \`status\`, \`reviewedById\`, \`reviewedAt\`, and
  \`reviewNote\` fields are updated atomically.
- A notification may be triggered to the clinic owner (via the
  notification module).

**Note:** Approving individual documents does not automatically
approve the tenant — that requires a separate explicit action at
\`POST /tenants/:id/approve\`.

**Who can call this:** \`super_admin\` only.
    `.trim(),
  })
  @ApiParam({ name: 'documentId', description: 'UUID of the document to review', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Document review recorded.',
    schema: S_DOCUMENT_DETAIL,
  })
  @ApiBadRequestResponse({
    description: '`status` must be `approved` or `rejected`.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not `super_admin`.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Document not found.', schema: S_ERROR })
  @Patch(':documentId/review')
  @Roles(ROLE.SUPER_ADMIN)
  review(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser('id') reviewerId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Body() dto: ReviewVerificationDocumentDto,
  ) {
    return this.verification.review(
      documentId,
      this.actor(reviewerId, ip, userAgent),
      dto,
    );
  }
}

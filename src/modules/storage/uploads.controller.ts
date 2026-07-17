import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Ip,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { StorageService } from './storage.service';
import { UploadObjectDto } from './dto/upload-object.dto';
import { ObjectKeyDto } from './dto/object-key.dto';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
} from './storage.constants';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AppError, ErrorCode } from '../../common/errors';
import { VerificationAuditService } from '../verification-audit/verification-audit.service';

/** Minimal shape of a multer in-memory file (avoids a hard @types/multer dep). */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Generic private-file gateway backed by Cloudflare R2.
 *
 *  - `POST   /uploads`            owner/manager stream a file → returns its key.
 *  - `GET    /uploads/signed-url` short-lived presigned GET for a key they own.
 *  - `DELETE /uploads`            remove an object they own.
 *
 * Objects are namespaced by tenant (`<tenantId>/…`); every read/delete asserts
 * the caller owns the prefix (super-admins may address any key). The bucket is
 * never public — clients only ever see opaque keys and time-boxed URLs. Every
 * action is recorded in the verification audit trail with actor IP + user agent.
 */
@ApiTags('Uploads')
@Controller('uploads')
@UseGuards(RolesGuard)
@ApiBearerAuth('JWT-auth')
export class UploadsController {
  constructor(
    private readonly storage: StorageService,
    private readonly ctx: TenantContextService,
    private readonly audit: VerificationAuditService,
  ) {}

  private actorRole(): string | undefined {
    return this.ctx.getUser()?.roles?.[0];
  }

  @ApiOperation({
    summary: 'Upload a private file to storage (owner/manager)',
    description:
      'Streams a `multipart/form-data` file to the private R2 bucket and returns its opaque `storageKey` plus metadata (incl. SHA-256). Allowed types: PDF, PNG, JPEG, WEBP. Content is validated by magic bytes — spoofed/corrupt files are rejected. Submit the returned `storageKey` to the consuming resource, never a URL.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'docType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        docType: { type: 'string', example: 'commercial_registration' },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        storageKey: { type: 'string' },
        filename: { type: 'string' },
        mimeType: { type: 'string' },
        size: { type: 'number' },
        sha256: { type: 'string' },
      },
    },
  })
  @Post()
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async upload(
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: UploadObjectDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    if (!file) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'No file uploaded. Send the file under the field name "file".',
      });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
      });
    }

    const tenantId = this.ctx.requireTenantId();
    const stored = await this.storage.upload({
      tenantId,
      docType: dto.docType,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });

    await this.audit.record({
      tenantId,
      action: 'UPLOADED',
      docType: dto.docType,
      actor: { id: userId, role: this.actorRole(), ip, userAgent },
      metadata: {
        storageKey: stored.storageKey,
        size: stored.size,
        mimeType: stored.mimeType,
        sha256: stored.sha256,
      },
    });
    return stored;
  }

  @ApiOperation({
    summary: 'Get a short-lived signed URL for a private object',
    description: `Returns a presigned GET URL valid for the configured TTL (default ${DEFAULT_SIGNED_URL_TTL_SECONDS}s). Owners/managers may only request keys under their own tenant prefix; super-admins may request any key. Each issuance is audited.`,
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        expiresIn: { type: 'number' },
      },
    },
  })
  @Get('signed-url')
  @Roles(ROLE.OWNER, ROLE.MANAGER, ROLE.SUPER_ADMIN)
  async signedUrl(
    @Query() query: ObjectKeyDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const superAdmin = this.ctx.isSuperAdmin();
    const tenantId = superAdmin ? '' : this.ctx.requireTenantId();
    if (!superAdmin) {
      this.storage.assertKeyBelongsToTenant(query.key, tenantId);
    }
    const url = await this.storage.getSignedDownloadUrl(query.key);

    await this.audit.record({
      tenantId: tenantId || query.key.split('/')[0],
      action: 'VIEWED',
      actor: { id: userId, role: this.actorRole(), ip, userAgent },
      metadata: { storageKey: query.key, superAdmin },
    });
    return { url, expiresIn: this.storage.signedUrlTtlSeconds };
  }

  @ApiOperation({
    summary: 'Delete a private object (owner/manager)',
    description:
      'Permanently removes an object the caller owns. Used by the "replace" flow before re-uploading. Audited.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
    },
  })
  @Delete()
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  async remove(
    @Query() query: ObjectKeyDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const tenantId = this.ctx.requireTenantId();
    this.storage.assertKeyBelongsToTenant(query.key, tenantId);
    await this.storage.deleteObject(query.key);

    await this.audit.record({
      tenantId,
      action: 'DELETED',
      actor: { id: userId, role: this.actorRole(), ip, userAgent },
      metadata: { storageKey: query.key },
    });
    return { deleted: true };
  }
}

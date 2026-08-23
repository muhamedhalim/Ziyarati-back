import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../auth/decorators/public.decorator';
import { SkipCsrf } from '../../auth/decorators/skip-csrf.decorator';
import { readGuestTokenCookie } from '../guest-token.util';
import { GuestSessionService } from '../guest-session.service';
import {
  GUEST_ATTACHMENT_MAX_BYTES,
  GUEST_CHAT_ATTACHMENT_UPLOAD_POLICY,
  MulterLimitsWithNestingDepth,
} from '../../storage/storage.constants';
import { AttachmentUploadExceptionFilter } from './attachment-upload-exception.filter';
import {
  GuestAttachmentService,
  type UploadedFile as UploadedFileLike,
} from './guest-attachment.service';

/**
 * Per-IP ceiling, on top of the per-GUEST Redis limiter in
 * `AiAttachmentStagingService`. The two answer different questions: the Redis
 * limiter bounds what one identity may do (and a guest identity is free to
 * mint), this bounds what one network source may do regardless of how many
 * identities it mints. Well below the global 300/60s bucket, because an
 * upload is orders of magnitude more expensive than a read.
 */
const GUEST_ATTACHMENT_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : 20,
    ttl: 60_000,
  },
};

/**
 * ZT-004b limits. `files: 1` and `fields: 1` matter as much as `fileSize`: a
 * multipart body with a thousand parts is a denial-of-service that never
 * exceeds any single-file size cap.
 */
const ATTACHMENT_UPLOAD_LIMITS: MulterLimitsWithNestingDepth = {
  fileSize: GUEST_ATTACHMENT_MAX_BYTES,
  files: 1,
  fields: 1,
  parts: 3,
  fieldNestingDepth: 1,
};

const ACCEPTED_MIMES = GUEST_CHAT_ATTACHMENT_UPLOAD_POLICY.allowedTypes
  .map((t) => t.mime)
  .join(', ');

/**
 * Files attached to the PUBLIC AI chat by anonymous visitors.
 *
 * Separate from `UploadsController` on purpose. That controller is
 * `@Roles(OWNER, MANAGER)` and writes tenant documents; this one is reachable
 * by anyone with a `guest_token` cookie, so it gets its own policy (a strict
 * four-format subset), its own size cap (5 MB, not 10), its own per-identity
 * and per-IP limiters, and its own error codes. Sharing a controller would
 * have meant one set of rules serving two populations with very different
 * threat models.
 *
 * `/attachments` in the path is load-bearing on the client: the frontend's
 * axios instance already raises its timeout to 60s for URLs containing
 * `/attachments` or `/upload`, which an extraction pass needs.
 */
@ApiTags('Guest Chat')
@Controller('public/guest/attachments')
@Throttle(GUEST_ATTACHMENT_THROTTLE)
// multer aborts an oversized stream from inside the interceptor, before the
// handler runs — see the filter for why that had to be translated.
@UseFilters(AttachmentUploadExceptionFilter)
export class GuestAttachmentController {
  constructor(
    private readonly guests: GuestSessionService,
    private readonly attachments: GuestAttachmentService,
  ) {}

  @Public()
  // Same reasoning as `POST /public/guest/session` (see its own comment):
  // `CsrfGuard` engages whenever an `access_token`/`refresh_token` cookie is
  // present, and a visitor can easily still be carrying a stale one. This
  // route authorizes on the `guest_token` cookie ALONE, which is
  // `SameSite=lax` and therefore not sent on a cross-site POST at all — so
  // the CSRF the guard would be defending against cannot reach it, while the
  // guard itself would lock out any visitor with a leftover auth cookie.
  @SkipCsrf()
  @ApiOperation({
    summary: 'Attach a file to the public AI chat (anonymous)',
    description:
      `Accepts one ${ACCEPTED_MIMES} file from a visitor holding a valid guest_token cookie. ` +
      'The declared content type, the filename extension and the leading magic bytes must all agree, or the file is rejected. ' +
      'Text is extracted server-side and the descriptor is held for 30 minutes; the next chat message that cites the returned id binds it to that conversation, single-use. ' +
      'Never returns 401 — an absent or invalid guest_token is the same 404 an unknown id gets, so this is not an existence oracle.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOkResponse({
    description:
      '{ id, name, mimeType, size, status } — `status` is `ready` when text was extracted, `unreadable` when the file was stored but yielded none.',
  })
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: ATTACHMENT_UPLOAD_LIMITS }),
  )
  async upload(
    @Req() req: Request,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    const owner = await this.guests.verifyGuest(readGuestTokenCookie(req));
    return this.attachments.upload(file, owner);
  }

  @Public()
  @SkipCsrf()
  @ApiOperation({
    summary: 'Discard a staged chat attachment (anonymous)',
    description:
      'Removes a file the visitor attached but has not yet sent. Always 204, whether or not the id existed — answering differently would let one visitor probe for another visitor\'s attachment ids. Once an attachment has been bound to a conversation by a message it can no longer be discarded here.',
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    const owner = await this.guests.verifyGuest(readGuestTokenCookie(req));
    await this.attachments.remove(id, owner);
  }
}

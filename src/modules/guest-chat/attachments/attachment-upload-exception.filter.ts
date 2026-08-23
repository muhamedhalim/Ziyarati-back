import {
  ArgumentsHost,
  Catch,
  PayloadTooLargeException,
} from '@nestjs/common';

import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { AppError, ErrorCode } from '../../../common/errors';
import { GUEST_ATTACHMENT_MAX_BYTES } from '../../storage/storage.constants';

/**
 * Translates multer's own size rejection into the code this surface promises.
 *
 * WHY IT IS NEEDED. `FileInterceptor`'s `limits.fileSize` aborts the stream
 * and throws `PayloadTooLargeException` from inside the interceptor pipeline —
 * BEFORE the controller method, and therefore before
 * `GuestAttachmentService.assertAcceptable`'s explicit `FILE_TOO_LARGE` check
 * can ever run. `normalizeException` has no mapping for it, so the response
 * carried `code: "INTERNAL_ERROR"`, and the widget — which localizes strictly
 * from the code and never renders the server's `message` — told the visitor
 * "something went wrong" about a file it knew perfectly well was too big.
 * Verified live before this filter existed: a 6 MB PDF returned
 * `413 … "code":"INTERNAL_ERROR"`.
 *
 * Keeping the interceptor limit is the point: it stops reading at the cap
 * instead of buffering an arbitrarily large body first. The service's own
 * check stays too — it is the one that runs for a body that fits under
 * multer's ceiling but still exceeds the policy (and the one the unit specs
 * exercise). This filter only makes the EARLIER rejection speak the same
 * language.
 *
 * Extends the global filter rather than formatting a response by hand, so the
 * body shape, request-id echo and production redaction stay identical to every
 * other error the API emits.
 */
@Catch(PayloadTooLargeException)
export class AttachmentUploadExceptionFilter extends AllExceptionsFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    super.catch(
      new AppError(ErrorCode.FILE_TOO_LARGE, {
        message: `File exceeds the maximum allowed size of ${GUEST_ATTACHMENT_MAX_BYTES} bytes`,
      }),
      host,
    );
  }
}

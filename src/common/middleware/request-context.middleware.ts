import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

import { getAppRevision } from '../utils/app-revision.util';
import { scrubText } from '../utils/log-scrubber.util';

export const REQUEST_ID_HEADER = 'x-request-id';

/** A caller-supplied correlation id is honoured only when it is short and boring. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * LSA-09: …and only when it carries machine-generated entropy — a UUID, or a
 * 16+ character run mixing letters and digits (ULIDs, trace ids, nanoids).
 * A phone number, a name or any other chosen word fails this, so a client
 * cannot write its own text into every log line of its request (and into the
 * job `correlationId` it propagates to).
 */
const GENERATED_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[A-Za-z0-9]{0,127}?[0-9])(?=[A-Za-z0-9]{0,127}?[A-Za-z])[A-Za-z0-9]{16,}/i;

export function isAcceptableRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    REQUEST_ID_PATTERN.test(value) &&
    GENERATED_ID_RE.test(value) &&
    scrubText(value) === value
  );
}

/**
 * Assigns a correlation id to every request.
 *
 * If an upstream caller (gateway, another service) already sent an
 * `X-Request-Id` of 1–128 characters from `[A-Za-z0-9._:-]` that looks
 * machine-generated (see `isAcceptableRequestId`), we honour it so a single
 * logical request can be traced across services. Anything else (empty,
 * oversized, other characters, or a chosen word/number such as a phone) is
 * replaced by a generated UUID so it can never be echoed into logs or
 * responses verbatim. The id is attached to the request object
 * (for guards/services/filters) and echoed back in the response header.
 *
 * Exposed as a plain Express handler (`requestContext`) for `app.use()`, and as
 * a Nest middleware class for `consumer.apply()` — both delegate to the same
 * logic.
 */
export function requestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId = isAcceptableRequestId(incoming) ? incoming : randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  const revision = getAppRevision();
  if (revision !== 'unknown') res.setHeader('X-App-Revision', revision);
  next();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    requestContext(req, res, next);
  }
}

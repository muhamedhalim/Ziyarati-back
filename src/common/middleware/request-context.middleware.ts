import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

import { getAppRevision } from '../utils/app-revision.util';

export const REQUEST_ID_HEADER = 'x-request-id';

/** A caller-supplied correlation id is honoured only when it is short and boring. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Assigns a correlation id to every request.
 *
 * If an upstream caller (gateway, another service) already sent an
 * `X-Request-Id` of 1–128 characters from `[A-Za-z0-9._:-]`, we honour it so a
 * single logical request can be traced across services. Anything else (empty,
 * oversized, other characters) is replaced by a generated UUID so it can never
 * be echoed into logs or responses verbatim. The id is attached to the request object
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
  const requestId =
    typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
      ? incoming
      : randomUUID();

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

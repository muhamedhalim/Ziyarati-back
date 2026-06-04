import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Assigns a correlation id to every request.
 *
 * If an upstream caller (gateway, another service) already sent an
 * `X-Request-Id`, we honour it so a single logical request can be traced across
 * services; otherwise we generate one. The id is attached to the request object
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
    typeof incoming === 'string' && incoming.trim().length > 0
      ? incoming
      : randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    requestContext(req, res, next);
  }
}

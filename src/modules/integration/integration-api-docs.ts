import { applyDecorators } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';

/**
 * Shared OpenAPI response documentation for the Integration API, so every
 * operation declares the outcomes it can actually produce (previously only
 * `/me` declared a 401 and nothing had a typed body).
 */

/** The canonical error body (see AllExceptionsFilter / ErrorResponseBody). */
export class IntegrationErrorResponseDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ example: 'AppError', description: 'Originating error class.' }) error!: string;
  @ApiProperty({
    example: 'CONFLICT',
    description:
      'Stable machine-readable code — branch on this. One of VALIDATION_ERROR, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, UNPROCESSABLE_ENTITY, RATE_LIMITED, SERVICE_UNAVAILABLE.',
  })
  code!: string;
  @ApiProperty({ example: 'The platform record has changed since this integration last wrote it' })
  message!: string;
  @ApiProperty({ example: '/api/v1/integrations/customers/upsert' }) path!: string;
  @ApiProperty({ example: '2026-10-12T10:00:00.000Z' }) timestamp!: string;
  @ApiProperty({ description: 'Quote this to support. Also sent as the X-Request-Id header.' })
  requestId!: string;
  @ApiPropertyOptional({
    description:
      'Client-safe details: `fields`, `protectedFields`, `reason`; for a refused upsert `{ outcome: "conflicted", reason, externalId, internalId, changedFields }`.',
    type: 'object',
    additionalProperties: true,
  })
  context?: Record<string, unknown>;
}

/** 200 body of every `POST .../upsert`. */
export class IntegrationUpsertResultDto {
  @ApiProperty({
    enum: ['created', 'updated', 'linked', 'skipped'],
    description:
      'What happened. A record the platform did NOT apply is a 409 (outcome "conflicted" in `context`), never a 200.',
  })
  outcome!: string;
  @ApiProperty({ example: 'PMS-10432' }) externalId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) internalId!: string | null;
  @ApiPropertyOptional({ type: [String], description: 'Fields whose value differed (created/linked/updated only).' })
  changedFields?: string[];
}

const DESCRIPTION: Record<number, string> = {
  400: 'Validation error — bad or missing field, malformed Idempotency-Key, or a timestamp without an explicit UTC offset. `context.fields` names the field.',
  401: 'API key missing, invalid, expired or revoked — identical body in every case.',
  403: 'The key lacks the scope for this endpoint, the clinic account is not active, or the feature is not enabled.',
  404: 'Unknown id, or it belongs to another clinic.',
  409: 'Conflict — Idempotency-Key still in flight, an upsert that was not applied (`context.outcome = "conflicted"`), or a forbidden lifecycle transition / already-taken slot.',
  413: 'Request body larger than 100 KB.',
  422: 'Well-formed but refused — protected field (`context.protectedFields`), Idempotency-Key reused with a different body, missing dependency, inactive connection.',
  429: 'Rate limit exceeded — honour the Retry-After header.',
  503: 'Temporarily unable to admit the request (nothing was written) — retry with backoff and the same Idempotency-Key.',
};

/** Declares each status with the shared error body. */
export function ApiIntegrationErrors(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, description: DESCRIPTION[status], type: IntegrationErrorResponseDto }),
    ),
  );
}

/** Read endpoints: query validation, not-found, auth, limits. */
export const ApiIntegrationReadErrors = () => ApiIntegrationErrors(400, 401, 403, 404, 429, 503);

/** `/me`: no inputs, so no 400/404. */
export const ApiIntegrationMeErrors = () => ApiIntegrationErrors(401, 403, 429, 503);

/** Upserts: the full set, plus the typed 200. */
export const ApiIntegrationWriteErrors = () =>
  applyDecorators(
    ApiOkResponse({ description: 'Applied (or a no-op).', type: IntegrationUpsertResultDto }),
    ApiIntegrationErrors(400, 401, 403, 404, 409, 413, 422, 429, 503),
  );

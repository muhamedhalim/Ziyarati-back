import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

import { IntegrationModule } from '../modules/integration/integration.module';

/**
 * Mounts the two API documentation surfaces, each gated by its own
 * independent flag (ZT-001). Extracted from `main.ts` so the gating
 * behaviour itself — not just its resolved config value — is directly
 * testable without booting the full production bootstrap (see
 * `api-docs.spec.ts`).
 *
 * Gating works by skipping `SwaggerModule.setup` (and the matching
 * `createDocument` build) ENTIRELY when a flag is off, rather than mounting
 * unconditionally and guarding the route — that is what removes the
 * rendered page and the machine-readable `-json` document TOGETHER; a route
 * guard would leave the JSON reachable, which is the exact disclosure this
 * gate exists to close (research.md D7).
 */
export function mountApiDocs(
  app: INestApplication,
  config: ConfigService,
): void {
  const enableApiDocs = config.get<string>('ENABLE_API_DOCS') === 'true';
  const enableIntegrationDocs =
    config.get<string>('ENABLE_INTEGRATION_DOCS') === 'true';

  if (enableApiDocs) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Clinic SaaS API')
      .setDescription('Auth + RBAC + Multi Tenant System')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        'JWT-auth',
      )
      .build();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);

    // Require the bearer scheme on EVERY operation, so clicking "Authorize" once
    // attaches `Authorization: Bearer <token>` to all requests (public routes
    // simply ignore it). Without this, only operations decorated with
    // @ApiBearerAuth('JWT-auth') send the token — the rest hit "No auth token".
    swaggerDocument.security = [{ 'JWT-auth': [] }];

    SwaggerModule.setup('docs', app, swaggerDocument, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  // ---------------- Integration API docs (separate, external-facing) ----------------
  // A distinct document scoped to ONLY the external integration controllers —
  // internal admin/dashboard routes must never appear here. Authenticated with
  // an API key (never the JWT bearer scheme above), so it gets its own
  // security scheme rather than reusing 'JWT-auth'.
  if (enableIntegrationDocs) {
    const integrationSwaggerConfig = new DocumentBuilder()
      .setTitle('Ziyarati Integration API')
      .setDescription(
        `
Read-only API for connecting an existing clinic system to Ziyarati.

**Authentication** — every request needs an API key, created from the clinic's
Developer Options page. Send it as either:
- \`X-API-Key: zk_...\`, or
- \`Authorization: ApiKey zk_...\`

**Scopes** — a key only works for the scopes it was granted at creation
(e.g. \`integration.services.read\`). A request to an endpoint the key wasn't
granted the scope for returns 403.

**Pagination** — list endpoints accept \`page\` (1-based) and \`limit\` (max 100)
and return \`{ data, total, page, limit }\`.

**Rate limits** — each key is limited per minute (429 \`RATE_LIMITED\` when
exceeded, with a \`context.retryAfterMs\` hint). The limit is configured per
deployment.

**Errors** — every error response has the shape
\`{ statusCode, code, error, message, path, timestamp, requestId, context? }\`.
Clients should branch on \`code\`. Common codes: \`UNAUTHORIZED\`
(missing/invalid/expired/revoked key, or the owning clinic is suspended),
\`FORBIDDEN\` (missing scope), \`NOT_FOUND\` (unknown id, or the resource belongs
to another clinic), \`VALIDATION_ERROR\` (bad query params), \`RATE_LIMITED\`.
      `.trim(),
      )
      .setVersion('1.0')
      .addApiKey(
        { type: 'apiKey', name: 'X-API-Key', in: 'header' },
        'ApiKey-auth',
      )
      .build();

    const integrationSwaggerDocument = SwaggerModule.createDocument(
      app,
      integrationSwaggerConfig,
      { include: [IntegrationModule] },
    );
    integrationSwaggerDocument.security = [{ 'ApiKey-auth': [] }];

    SwaggerModule.setup('docs/integrations', app, integrationSwaggerDocument, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }
}

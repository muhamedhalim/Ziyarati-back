import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

import { IntegrationModule } from '../modules/integration/integration.module';
import { INTEGRATION_API_GUIDE } from './integration-api-guide';

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
      // The full partner guide (auth, limits, errors, both webhook directions
      // and their signature schemes) lives in its own module so its claims can
      // be pinned to the runtime constants by a spec.
      .setDescription(INTEGRATION_API_GUIDE)
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

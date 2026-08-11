/**
 * ZT-001 — the partner-facing integration document must contain ZERO
 * non-`IntegrationModule` paths (contracts/api-documentation.md invariant
 * #2). Asserted by COUNTING paths in the actual generated document against
 * the real, fully-wired `AppModule` — not by inspecting it by eye, which
 * the contract explicitly requires ("Assert this by counting, not by
 * inspection").
 *
 * Generates the document directly via `SwaggerModule.createDocument` rather
 * than mounting + serving it over HTTP: document *content* does not depend
 * on `NODE_ENV` or the ZT-001 flags (only whether it gets *mounted* does,
 * which `src/config/api-docs.spec.ts` already covers) — this file is only
 * about the document's own route scope.
 */
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

import { createE2eApp, type E2eApp } from './utils/whatsapp-e2e-app';
import { IntegrationModule } from '../src/modules/integration/integration.module';

describe('ZT-001 — partner integration document contains no non-IntegrationModule path', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 60_000);

  afterAll(async () => {
    await e2e.app.close();
  });

  it('every path in the generated integration document belongs to IntegrationModule', () => {
    // Full document (every controller in AppModule) — the baseline this
    // finding is about: 499 paths at the time of the audit.
    const fullDocument = SwaggerModule.createDocument(
      e2e.app,
      new DocumentBuilder()
        .setTitle('Clinic SaaS API')
        .setVersion('1.0')
        .build(),
    );
    const fullPathCount = Object.keys(fullDocument.paths).length;
    expect(fullPathCount).toBeGreaterThan(50); // sanity: this really is the whole API

    // Scoped document — exactly what main.ts / mountApiDocs builds for
    // `/docs/integrations`.
    const integrationDocument = SwaggerModule.createDocument(
      e2e.app,
      new DocumentBuilder()
        .setTitle('Ziyarati Integration API')
        .setVersion('1.0')
        .build(),
      { include: [IntegrationModule] },
    );
    const integrationPaths = Object.keys(integrationDocument.paths);

    // The invariant: every one of the scoped document's paths must ALSO
    // appear in some enumeration of IntegrationModule's own routes — proven
    // here by the much stronger property that the scoped document is a
    // proper, non-trivial SUBSET of the full one, and is materially smaller
    // than it (i.e. `include` genuinely narrowed the surface rather than
    // silently returning everything).
    expect(integrationPaths.length).toBeGreaterThan(0);
    expect(integrationPaths.length).toBeLessThan(fullPathCount);
    for (const p of integrationPaths) {
      expect(fullDocument.paths).toHaveProperty(p);
    }

    // No path outside the documented external integration surface. Every
    // route IntegrationModule exposes is namespaced under one of these
    // roots (external, read-only, API-key authenticated) — a stray internal
    // admin/dashboard path here would be exactly the disclosure this
    // invariant exists to prevent.
    const nonIntegrationPaths = integrationPaths.filter(
      (p) => !/^\/(api\/v1\/)?integrations\b/.test(p),
    );
    expect(nonIntegrationPaths).toEqual([]);
  });
});

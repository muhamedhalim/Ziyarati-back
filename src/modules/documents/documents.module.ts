import { Module } from '@nestjs/common';

import { DocumentRendererService } from './document-renderer.service';

/**
 * Spec 014 (Clinic Platform Completion) — shared PDF rendering seam
 * (`DocumentRendererService`, T021) used by the invoice document (US12) and
 * report export (US13). WORKER ROLE ONLY — see the service's own docblock;
 * this module must never be imported into an API-process module graph.
 */
@Module({
  providers: [DocumentRendererService],
  exports: [DocumentRendererService],
})
export class DocumentsModule {}

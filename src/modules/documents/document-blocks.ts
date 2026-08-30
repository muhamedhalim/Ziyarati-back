/**
 * Spec 014 (Clinic Platform Completion) — T021. The abstract content a
 * `DocumentTemplate` produces: LAYOUT only, no domain semantics. A concrete
 * template (invoice — T091, report export — T178) turns its own domain data
 * into this shape; `DocumentRendererService` turns this shape into a PDF,
 * and never has to know what an "invoice" or a "report" is.
 */
export type DocumentBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'keyValue'; rows: { label: string; value: string }[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'spacer' };

/**
 * `render(template, data, locale)` calls `template.toBlocks(data, locale)`
 * to get the locale-resolved content, per contracts/internal-seams.md §7.
 */
export interface DocumentTemplate {
  toBlocks(data: unknown, locale: 'ar' | 'en'): DocumentBlock[];
}

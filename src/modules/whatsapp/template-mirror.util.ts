import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import type { MetaTemplate } from './meta/meta-graph.client';
import { mapMetaTemplateStatus, normalizeRejectionReason } from './template-status.util';

/**
 * `components` is a jsonb column typed as an object, but Meta sends an array.
 * Wrap it so the stored shape stays stable and readable rather than depending
 * on how the driver serializes a bare array. The template's parameter format
 * rides along inside the same envelope (no schema change) because the send
 * path needs it: a NAMED template is filled by parameter name, a POSITIONAL one
 * by position.
 */
export function normalizeComponents(
  components: unknown,
  parameterFormat?: string,
): Record<string, unknown> | undefined {
  if (components === null || components === undefined) return undefined;
  const envelope: Record<string, unknown> = Array.isArray(components)
    ? { components }
    : { ...(components as Record<string, unknown>) };
  if (parameterFormat) envelope.parameter_format = parameterFormat.toUpperCase();
  return envelope;
}

/**
 * Writes what Meta said about a template onto a mirror row.
 *
 * The ONE place a Meta template becomes a row, shared by the pull sync and the
 * single-template refresh so the two cannot disagree about what a status or a
 * rejection reason looks like. Meta always wins: this overwrites, never merges.
 *
 * `null` (not `undefined`) is assigned to cleared columns because TypeORM's
 * `save` treats `undefined` as "leave unchanged" — an approved template would
 * otherwise keep the rejection reason of its earlier life.
 */
export function applyRemoteTemplate(
  row: WhatsappTemplate,
  remote: MetaTemplate,
  at: Date,
  onUnknownStatus?: (status: string | undefined) => void,
): void {
  row.provider_template_id = remote.id;
  row.name = remote.name;
  row.language = remote.language;
  row.category = remote.category ?? row.category;
  row.components =
    normalizeComponents(remote.components, remote.parameterFormat) ?? row.components;
  row.status = mapMetaTemplateStatus(remote.status, onUnknownStatus);
  row.rejected_reason = (normalizeRejectionReason(remote.rejectedReason) ??
    null) as unknown as string | undefined;
  row.last_synced_at = at;
}

import {
  orderedBodyParameters,
  unsupportedTemplateShape,
  urlButtonParameters,
} from './template-variables.util';
import {
  fixedSourceValue,
  isFixedSource,
  WHATSAPP_CONNECTION_STATUS,
  WHATSAPP_TEMPLATE_STATUS,
} from './whatsapp.constants';

/**
 * Why a template can or cannot be used to send RIGHT NOW.
 *
 * One definition shared by the list API (what the card shows) and by whatever
 * decides to switch an automation on, so the UI's "ready" and the server's
 * "allowed" can never disagree. The UI uses the codes to explain and to disable
 * actions; it is never the authority — the send seam re-checks everything.
 *
 * `blocking: false` reasons are warnings. Staleness is one: a status that has
 * not been reconciled with Meta recently is not proof the template is unusable,
 * so it does not block by itself — callers that are about to rely on the status
 * (switching a rule on) refresh it from Meta first.
 */
export type ReadinessReasonCode =
  | 'NOT_SUBMITTED'
  | 'IN_REVIEW'
  | 'REJECTED'
  | 'PAUSED'
  | 'DISABLED'
  | 'NO_ACCOUNT'
  | 'ACCOUNT_NOT_CONNECTED'
  | 'WABA_MISMATCH'
  | 'UNSUPPORTED_SHAPE'
  | 'UNBOUND_VARIABLES'
  | 'STATUS_STALE';

export interface ReadinessReason {
  code: ReadinessReasonCode;
  blocking: boolean;
  /** Placeholders for `UNBOUND_VARIABLES`; the shape complaint for `UNSUPPORTED_SHAPE`. */
  params?: Record<string, string | string[]>;
}

export interface TemplateReadiness {
  ready: boolean;
  reasons: ReadinessReason[];
}

export interface ReadinessAccount {
  connection_status?: string | null;
  is_active?: boolean | null;
  waba_id?: string | null;
}

export interface ReadinessInput {
  status: string;
  components?: unknown;
  variable_mapping?: Record<string, string> | null;
  waba_id?: string | null;
  needs_refresh: boolean;
}

/** Placeholders (body + dynamic URL buttons) that have no usable data source yet. */
export function unboundPlaceholders(t: {
  components?: unknown;
  variable_mapping?: Record<string, string> | null;
}): string[] {
  const declared = [
    ...orderedBodyParameters(t.components),
    ...urlButtonParameters(t.components).map((p) => p.key),
  ];
  return declared.filter((name) => {
    const source = t.variable_mapping?.[name];
    if (!source) return true;
    // `fixed:` with nothing after it is not a binding.
    return isFixedSource(source) && !fixedSourceValue(source);
  });
}

export function computeReadiness(
  t: ReadinessInput,
  account: ReadinessAccount | null | undefined,
): TemplateReadiness {
  const reasons: ReadinessReason[] = [];
  const block = (
    code: ReadinessReasonCode,
    params?: ReadinessReason['params'],
  ) => reasons.push({ code, blocking: true, params });

  switch (t.status) {
    case WHATSAPP_TEMPLATE_STATUS.APPROVED:
      break;
    case WHATSAPP_TEMPLATE_STATUS.DRAFT:
      block('NOT_SUBMITTED');
      break;
    case WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW:
      block('IN_REVIEW');
      break;
    case WHATSAPP_TEMPLATE_STATUS.REJECTED:
      block('REJECTED');
      break;
    case WHATSAPP_TEMPLATE_STATUS.PAUSED:
      block('PAUSED');
      break;
    default:
      // `disabled`, and anything this build does not recognise: never ready.
      block('DISABLED');
  }

  if (!account) {
    block('NO_ACCOUNT');
  } else {
    if (
      account.is_active === false ||
      (account.connection_status &&
        account.connection_status !== WHATSAPP_CONNECTION_STATUS.CONNECTED)
    ) {
      block('ACCOUNT_NOT_CONNECTED');
    }
    if (t.waba_id && account.waba_id && t.waba_id !== account.waba_id)
      block('WABA_MISMATCH');
  }

  const unsupported = unsupportedTemplateShape(t.components);
  if (unsupported) block('UNSUPPORTED_SHAPE', { detail: unsupported });

  const unbound = unboundPlaceholders(t);
  if (unbound.length > 0) block('UNBOUND_VARIABLES', { placeholders: unbound });

  // Only meaningful once there is a Meta verdict to be stale.
  if (t.needs_refresh && t.status !== WHATSAPP_TEMPLATE_STATUS.DRAFT) {
    reasons.push({ code: 'STATUS_STALE', blocking: false });
  }

  return { ready: !reasons.some((r) => r.blocking), reasons };
}

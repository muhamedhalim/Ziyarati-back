/**
 * WhatsApp message delivery-provider abstraction (strategy pattern).
 *
 * Business logic depends ONLY on this interface — never on the Meta Cloud API /
 * Twilio / 360dialog SDKs. A concrete adapter implements `supports()` and is
 * registered into the `WHATSAPP_MESSAGE_PROVIDERS` multi-provider token; the
 * factory resolves one at send time. Adding a real provider later requires NO
 * change to the messaging/execution services.
 */
export interface WhatsappSendPayload {
  tenantId: string;
  /** Resolved account id, or 'platform-env' for the env-level shared number. */
  accountId: string;
  /** Routing metadata resolved by WhatsappMessageRouter (no secrets here). */
  mode?: string;
  phoneNumberId?: string;
  /** Destination WhatsApp id / phone (E.164 digits). */
  to: string;
  templateId: string;
  templateName: string;
  language: string;
  /** Template variable substitutions (no secrets). */
  variables?: Record<string, unknown>;
}

export interface WhatsappSendResult {
  success: boolean;
  /** Opaque provider message id (e.g. WhatsApp `wamid`). */
  providerMessageId?: string;
  error?: string;
}

/** A tappable reply button (interactive `button` message, max 3 per message). */
export interface WhatsappReplyButton {
  /** Stable id echoed back in the inbound `button_reply` when tapped. */
  id: string;
  /** Button label (max 20 chars — Meta truncates beyond that). */
  title: string;
}

/** A single selectable row inside a list message section. */
export interface WhatsappListRow {
  id: string;
  title: string;
  description?: string;
}

/** A named section grouping list rows (interactive `list` message). */
export interface WhatsappListSection {
  title?: string;
  rows: WhatsappListRow[];
}

/**
 * A FREE-FORM session message — the reply type used inside the 24h customer
 * service window (opened by an inbound message). Unlike template sends this
 * needs no pre-approved template, so it is what the AI uses to reply on WhatsApp.
 * `interactive` is optional: when present the provider renders tappable buttons
 * or a selectable list; otherwise a plain text bubble is sent.
 */
export interface WhatsappSessionPayload {
  tenantId: string;
  accountId: string;
  mode?: string;
  phoneNumberId?: string;
  /** Destination WhatsApp id / phone (E.164 digits). */
  to: string;
  /** Body text (also the interactive body when buttons/list are present). */
  text: string;
  interactive?: {
    buttons?: WhatsappReplyButton[];
    list?: {
      /** Label on the button that opens the list (e.g. "Choose a clinic"). */
      buttonText: string;
      sections: WhatsappListSection[];
    };
    /** Optional header/footer for the interactive bubble. */
    header?: string;
    footer?: string;
  };
}

export interface WhatsappMessageProvider {
  /** Human-readable provider name (for logs/diagnostics). */
  readonly name: string;
  /** Returns true if this provider can deliver (e.g. by account/region). */
  supports(payload?: WhatsappSendPayload): boolean;
  /** Performs the send. Must not throw for expected failures — return
   *  `{ success: false, error }` so the executor can log + retry. */
  send(payload: WhatsappSendPayload): Promise<WhatsappSendResult>;
  /**
   * Sends a free-form session (text / interactive) message inside the 24h
   * service window. Optional so existing providers stay valid; the messaging
   * service reports a clear error when a resolved provider lacks it.
   */
  sendSession?(payload: WhatsappSessionPayload): Promise<WhatsappSendResult>;
}

/** Multi-provider DI token: an array of registered WhatsApp message providers. */
export const WHATSAPP_MESSAGE_PROVIDERS = Symbol('WHATSAPP_MESSAGE_PROVIDERS');

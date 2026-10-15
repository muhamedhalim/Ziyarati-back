import { Injectable } from '@nestjs/common';

import { WorkflowActionSpec } from '../../entities/Workflows/Workflow';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.templates';
import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import {
  WHATSAPP_CHANNEL,
  WHATSAPP_DELIVERY_STATUS,
} from '../whatsapp/whatsapp.constants';
import {
  missingVariables,
  renderTemplateBody,
} from '../whatsapp/template-variables.util';
import {
  WORKFLOW_ACTION_TYPE,
  WORKFLOW_RECIPIENT_TYPES,
} from './workflow.constants';
import { WorkflowRecipientResolver } from './workflow-recipient.resolver';
import {
  hasWorkflowPlaceholder,
  renderWorkflowMessage,
} from './workflow-message-placeholders';

export interface ActionOutcome {
  status: 'SUCCEEDED' | 'FAILED';
  detail?: string;
}

/**
 * Executes ONE workflow action by delegating to the EXISTING domain services —
 * the engine adds no business logic of its own:
 *   EMAIL    → EmailService (queued, idempotent, template-rendered)
 *   WHATSAPP → WhatsappMessagingService.sendSession (Cloud API session msg),
 *              optionally sourcing its text from an approved WhatsappTemplate
 *
 * Both action types resolve their recipient the SAME way, via
 * `WorkflowRecipientResolver` — `recipientType` (CUSTOMER | STAFF) plus the
 * run's `context.customerId`/`context.staffId`, never a raw address typed
 * into the builder.
 *
 * `dryRun` (the manual "Test Run" button) performs every real step EXCEPT
 * the actual provider send — recipient resolution, template lookup/
 * rendering, and content-completeness validation all still run for real, so
 * a dry run genuinely proves the action would work, without ever contacting
 * WhatsApp/Email. Its outcome detail is deliberately non-PII (recipient
 * TYPE, not the resolved address).
 *
 * Never throws for expected failures — returns a typed outcome the processor
 * records on the run (so a failed action retries at the queue, and the audit
 * trail stays complete).
 */
@Injectable()
export class WorkflowActionExecutor {

  constructor(
    private readonly email: EmailService,
    private readonly whatsappMessaging: WhatsappMessagingService,
    private readonly whatsappRouter: WhatsappMessageRouter,
    private readonly whatsappExecution: WhatsappExecutionService,
    private readonly whatsappTemplates: WhatsappTemplateService,
    private readonly recipients: WorkflowRecipientResolver,
  ) {}

  /**
   * `actionIndex` (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.11)
   * feeds a per-action BUSINESS idempotency key (`workflow-action:{runId}:
   * {actionIndex}`), used below by whichever type-specific handler has a way
   * to use it. This exists because `WorkflowService.claimAction`'s atomic
   * claim only prevents CONCURRENT double-execution; it cannot prevent a
   * crash AFTER the side effect below already ran and BEFORE the claim's
   * result is recorded (see that method's docstring) from being reclaimed
   * later and re-executed. Each handler closes that specific residual window
   * using whatever mechanism fits its own operation type — a business key
   * (EMAIL, which already has a content-addressed log) or a database unique
   * constraint (WHATSAPP, which does not).
   */
  async execute(
    tenantId: string,
    runId: string,
    actionIndex: number,
    action: WorkflowActionSpec,
    context: Record<string, unknown>,
    dryRun = false,
  ): Promise<ActionOutcome> {
    const cfg = action.config ?? {};
    const idempotencyKey = `workflow-action:${runId}:${actionIndex}`;
    const recipientType = this.str(action.recipientType);
    if (!recipientType || !WORKFLOW_RECIPIENT_TYPES.includes(recipientType)) {
      return {
        status: 'FAILED',
        detail: 'Action requires a valid recipientType ("CUSTOMER" or "STAFF")',
      };
    }
    try {
      switch (action.type) {
        case WORKFLOW_ACTION_TYPE.EMAIL:
          return await this.email_(
            tenantId,
            recipientType,
            cfg,
            context,
            idempotencyKey,
            dryRun,
          );
        case WORKFLOW_ACTION_TYPE.WHATSAPP:
          return await this.whatsapp_(
            tenantId,
            recipientType,
            cfg,
            context,
            idempotencyKey,
            dryRun,
          );
        default:
          return {
            status: 'FAILED',
            detail: `Unknown action type "${action.type}"`,
          };
      }
    } catch (err) {
      return {
        status: 'FAILED',
        detail: (err as Error)?.message ?? 'action error',
      };
    }
  }

  // ── EMAIL ───────────────────────────────────────────────────────────────

  private async email_(
    tenantId: string,
    recipientType: string,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>,
    idempotencyKey: string,
    dryRun: boolean,
  ): Promise<ActionOutcome> {
    const contact = await this.recipients.resolve(
      tenantId,
      recipientType,
      context,
    );
    if (!contact?.email) {
      return {
        status: 'FAILED',
        detail: `Could not resolve an email address for recipientType "${recipientType}"`,
      };
    }
    const template = (this.str(cfg.templateKey) ??
      'generic') as EmailTemplateKey;

    if (dryRun) {
      return {
        status: 'SUCCEEDED',
        detail: `[dry run] EMAIL ("${template}") would be sent to ${recipientType.toLowerCase()}`,
      };
    }

    const variables: Record<string, unknown> = {
      ...(this.obj(cfg.variables) ?? {}),
      ...(this.str(cfg.subject) ? { subject: this.str(cfg.subject) } : {}),
      ...(this.str(cfg.body)
        ? { body: this.str(cfg.body), message: this.str(cfg.body) }
        : {}),
      context,
    };
    // Business key, NOT the content-hash fallback — a stale-reclaimed retry of
    // THIS action must dedupe on being the SAME action, even if `context`
    // (and therefore the rendered content) has since drifted.
    await this.email.send({
      to: contact.email,
      template,
      variables,
      tenantId,
      idempotencyKey,
    });
    return {
      status: 'SUCCEEDED',
      detail: `email "${template}" queued to ${recipientType.toLowerCase()}`,
    };
  }

  // ── WHATSAPP ──────────────────────────────────────────────────────────────

  /**
   * Unlike EMAIL (which reuses `email_logs`' own content-addressed claim),
   * `sendSession` has NO persistence or idempotency of its own (see
   * `WhatsappMessagingService` — "holds no persistence"). A stale-reclaimed
   * retry of this action would otherwise send the WhatsApp message a second
   * time with NOTHING stopping it. `WhatsappExecutionService.claimBySourceRef`
   * gives it the same DB-unique-constraint floor NOTIFICATION used to get —
   * see migration `WorkflowActionSourceRef1730016000000`.
   */
  private async whatsapp_(
    tenantId: string,
    recipientType: string,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>,
    idempotencyKey: string,
    dryRun: boolean,
  ): Promise<ActionOutcome> {
    const contact = await this.recipients.resolve(
      tenantId,
      recipientType,
      context,
    );
    if (!contact?.phone) {
      return {
        status: 'FAILED',
        detail: `Could not resolve a WhatsApp number for recipientType "${recipientType}"`,
      };
    }
    const to = contact.phone;

    let text = this.str(cfg.text);
    const templateId = this.str(cfg.templateId);
    if (templateId) {
      // Throws NOT_FOUND / UNPROCESSABLE_ENTITY (not-approved) — caught by
      // `execute()`'s try/catch and turned into a FAILED outcome, same as
      // every other expected failure here.
      const template = await this.whatsappTemplates.getSendableTemplate(
        tenantId,
        templateId,
      );
      const variables = this.obj(cfg.variables);
      const missing = missingVariables(template.components, variables);
      if (missing.length) {
        return {
          status: 'FAILED',
          detail: `WhatsApp template is missing variable(s): ${missing.join(', ')}`,
        };
      }
      text = renderTemplateBody(template.components, variables);
    }
    if (!text) {
      return {
        status: 'FAILED',
        detail: 'WHATSAPP action requires `text` or an approved `templateId`',
      };
    }
    // Plain-text messages may address the patient/clinic by placeholder. An
    // approved template's text has already been fully rendered above.
    if (!templateId && hasWorkflowPlaceholder(text)) {
      text = renderWorkflowMessage(
        text,
        await this.recipients.placeholderValues(tenantId, context),
      );
    }

    if (dryRun) {
      return {
        status: 'SUCCEEDED',
        detail: `[dry run] WHATSAPP would be sent to ${recipientType.toLowerCase()}`,
      };
    }

    const claim = await this.whatsappExecution.claimBySourceRef(
      tenantId,
      WHATSAPP_CHANNEL,
      idempotencyKey,
    );
    if (!claim.claimed) {
      return {
        status: 'SUCCEEDED',
        detail: `whatsapp already sent for this action (dedup via ${idempotencyKey})`,
      };
    }

    // The action can only send from this tenant's own connected number — there
    // is no shared platform number to fall back to, so an unresolvable account
    // is a failed action, not a silent downgrade.
    let account;
    try {
      account = await this.whatsappRouter.resolveForSend(tenantId, {});
    } catch (err) {
      const detail = (err as Error)?.message ?? 'no usable WhatsApp account';
      await this.whatsappExecution.finalizeBySourceRef(
        claim.log.id,
        WHATSAPP_DELIVERY_STATUS.FAILED,
        { error: detail },
      );
      return { status: 'FAILED', detail };
    }

    const res = await this.whatsappMessaging.sendSession({
      tenantId,
      accountId: account.id,
      phoneNumberId: account.phoneNumberId,
      mode: account.mode,
      to,
      text,
    });
    // provider_ref is written REGARDLESS of outcome — narrows (does not
    // eliminate; see WhatsappExecutionService.sendTemplateMessage's
    // RECONCILIATION docstring for the same residual crash window here) the
    // gap between the provider accepting the message and us durably
    // recording that fact.
    await this.whatsappExecution.finalizeBySourceRef(
      claim.log.id,
      res.success
        ? WHATSAPP_DELIVERY_STATUS.SENT
        : WHATSAPP_DELIVERY_STATUS.FAILED,
      {
        providerRef: res.providerMessageId,
        error: res.success ? undefined : res.error,
        sentAt: res.success ? new Date() : undefined,
      },
    );
    return res.success
      ? {
          status: 'SUCCEEDED',
          detail: `whatsapp sent to ${recipientType.toLowerCase()} (${res.providerMessageId ?? 'ok'})`,
        }
      : { status: 'FAILED', detail: res.error ?? 'whatsapp send failed' };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v : undefined;
  }

  private obj(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  }
}

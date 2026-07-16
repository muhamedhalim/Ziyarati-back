import { createHmac } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { WorkflowActionSpec } from '../../entities/Workflows/Workflow';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.templates';
import { NotificationSchedulerService } from '../notifications/notification-scheduler.service';
import { RECIPIENT_TYPE } from '../notifications/notification.constants';
import { WhatsappMessagingService } from '../whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../whatsapp/routing/whatsapp-message.router';
import type {
  WhatsappReplyButton,
  WhatsappListSection,
} from '../whatsapp/providers/whatsapp-message.provider.interface';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { AI_CHANNEL } from '../ai-orchestrator/ai-channel.constants';
import { WORKFLOW_ACTION_TYPE } from './workflow.constants';

export interface ActionOutcome {
  status: 'SUCCEEDED' | 'FAILED';
  detail?: string;
}

/**
 * Executes ONE workflow action by delegating to the EXISTING domain services —
 * the engine adds no business logic of its own:
 *   EMAIL        → EmailService (queued, idempotent, template-rendered)
 *   WHATSAPP     → WhatsappMessagingService.sendSession (Cloud API session msg)
 *   NOTIFICATION → NotificationSchedulerService (scheduled-notification pipeline)
 *   WEBHOOK      → signed outbound HTTP POST
 *   AI           → AiOrchestratorService.handle (single AI execution path)
 *
 * Never throws for expected failures — returns a typed outcome the processor
 * records on the run (so a failed action retries at the queue, and the audit
 * trail stays complete).
 */
@Injectable()
export class WorkflowActionExecutor {
  private readonly logger = new Logger('WorkflowActionExecutor');
  private readonly webhookTimeoutMs = Number(process.env.WORKFLOW_WEBHOOK_TIMEOUT_MS ?? '8000');

  constructor(
    private readonly email: EmailService,
    private readonly whatsappMessaging: WhatsappMessagingService,
    private readonly whatsappRouter: WhatsappMessageRouter,
    private readonly notifications: NotificationSchedulerService,
    private readonly orchestrator: AiOrchestratorService,
  ) {}

  async execute(
    tenantId: string,
    runId: string,
    action: WorkflowActionSpec,
    context: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    const cfg = action.config ?? {};
    try {
      switch (action.type) {
        case WORKFLOW_ACTION_TYPE.EMAIL:
          return await this.email_(tenantId, cfg, context);
        case WORKFLOW_ACTION_TYPE.WHATSAPP:
          return await this.whatsapp_(tenantId, cfg, context);
        case WORKFLOW_ACTION_TYPE.NOTIFICATION:
          return await this.notification_(tenantId, cfg, context);
        case WORKFLOW_ACTION_TYPE.WEBHOOK:
          return await this.webhook_(tenantId, runId, cfg, context);
        case WORKFLOW_ACTION_TYPE.AI:
          return await this.ai_(tenantId, cfg);
        default:
          return { status: 'FAILED', detail: `Unknown action type "${action.type}"` };
      }
    } catch (err) {
      return { status: 'FAILED', detail: (err as Error)?.message ?? 'action error' };
    }
  }

  // ── EMAIL ───────────────────────────────────────────────────────────────

  private async email_(
    tenantId: string,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    const to = this.recipients(cfg.to);
    if (!to) return { status: 'FAILED', detail: 'EMAIL action requires `to`' };
    const template = (this.str(cfg.template) ?? 'generic') as EmailTemplateKey;
    const variables: Record<string, unknown> = {
      ...(this.obj(cfg.variables) ?? {}),
      ...(this.str(cfg.subject) ? { subject: this.str(cfg.subject) } : {}),
      ...(this.str(cfg.body) ? { body: this.str(cfg.body), message: this.str(cfg.body) } : {}),
      context,
    };
    await this.email.send({ to, template, variables, tenantId });
    return { status: 'SUCCEEDED', detail: `email "${template}" queued to ${Array.isArray(to) ? to.length + ' recipients' : to}` };
  }

  // ── WHATSAPP ──────────────────────────────────────────────────────────────

  private async whatsapp_(
    tenantId: string,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    const to = this.str(cfg.to) ?? this.str(context.waId);
    const text = this.str(cfg.text);
    if (!to || !text) return { status: 'FAILED', detail: 'WHATSAPP action requires `to` and `text`' };

    // The action can only send from this tenant's own connected number — there
    // is no shared platform number to fall back to, so an unresolvable account
    // is a failed action, not a silent downgrade.
    let account;
    try {
      account = await this.whatsappRouter.resolveForSend(tenantId, {});
    } catch (err) {
      return { status: 'FAILED', detail: (err as Error)?.message ?? 'no usable WhatsApp account' };
    }

    const buttons = this.buttons(cfg.buttons);
    const list = this.list(cfg.list);
    const res = await this.whatsappMessaging.sendSession({
      tenantId,
      accountId: account.id,
      phoneNumberId: account.phoneNumberId,
      mode: account.mode,
      to,
      text,
      ...(buttons || list ? { interactive: { ...(buttons ? { buttons } : {}), ...(list ? { list } : {}) } } : {}),
    });
    return res.success
      ? { status: 'SUCCEEDED', detail: `whatsapp sent (${res.providerMessageId ?? 'ok'})` }
      : { status: 'FAILED', detail: res.error ?? 'whatsapp send failed' };
  }

  // ── NOTIFICATION ────────────────────────────────────────────────────────

  private async notification_(
    tenantId: string,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    const templateId = this.str(cfg.templateId);
    if (!templateId) return { status: 'FAILED', detail: 'NOTIFICATION action requires `templateId`' };
    const recipientId = this.str(cfg.recipientId) ?? this.str(context.customerId) ?? this.str(context.tenantId) ?? tenantId;
    const recipientType = this.str(cfg.recipientType) ?? (this.str(context.customerId) ? RECIPIENT_TYPE.CUSTOMER : RECIPIENT_TYPE.TENANT);
    const scheduled = await this.notifications.schedule(tenantId, {
      templateId,
      appointmentId: this.str(context.appointmentId),
      recipientType,
      recipientId,
      scheduledAt: new Date().toISOString(),
    });
    return { status: 'SUCCEEDED', detail: `notification scheduled (${scheduled.id})` };
  }

  // ── WEBHOOK ───────────────────────────────────────────────────────────────

  private async webhook_(
    tenantId: string,
    runId: string,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    const url = this.str(cfg.url);
    if (!url || !/^https?:\/\//i.test(url)) return { status: 'FAILED', detail: 'WEBHOOK action requires a valid http(s) `url`' };
    const body = JSON.stringify({ tenantId, runId, context, sentAt: new Date().toISOString() });
    const secret = this.str(cfg.secret);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Workflow-Signature'] = createHmac('sha256', secret).update(body).digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.webhookTimeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      return res.ok
        ? { status: 'SUCCEEDED', detail: `webhook ${res.status}` }
        : { status: 'FAILED', detail: `webhook HTTP ${res.status}` };
    } catch (err) {
      const message = (err as Error)?.name === 'AbortError' ? 'webhook timeout' : (err as Error)?.message;
      return { status: 'FAILED', detail: message ?? 'webhook error' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── AI ──────────────────────────────────────────────────────────────────

  private async ai_(tenantId: string, cfg: Record<string, unknown>): Promise<ActionOutcome> {
    const prompt = this.str(cfg.prompt);
    if (!prompt) return { status: 'FAILED', detail: 'AI action requires `prompt`' };
    const result = await this.orchestrator.handle(tenantId, {
      channel: AI_CHANNEL.API,
      content: prompt,
      agentId: this.str(cfg.agentId),
    });
    return { status: 'SUCCEEDED', detail: `ai replied (conv ${result.aiConversationId})` };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private recipients(v: unknown): string | string[] | undefined {
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      return list.length ? list : undefined;
    }
    return undefined;
  }

  private buttons(v: unknown): WhatsappReplyButton[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b) => ({ id: this.str(b.id) ?? '', title: this.str(b.title) ?? '' }))
      .filter((b) => b.id && b.title);
    return out.length ? out : undefined;
  }

  private list(v: unknown): { buttonText: string; sections: WhatsappListSection[] } | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const obj = v as Record<string, unknown>;
    const sectionsRaw = Array.isArray(obj.sections) ? obj.sections : [];
    const sections: WhatsappListSection[] = sectionsRaw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        title: this.str(s.title),
        rows: (Array.isArray(s.rows) ? s.rows : [])
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((r) => ({ id: this.str(r.id) ?? '', title: this.str(r.title) ?? '', description: this.str(r.description) }))
          .filter((r) => r.id && r.title),
      }))
      .filter((s) => s.rows.length > 0);
    if (!sections.length) return undefined;
    return { buttonText: this.str(obj.buttonText) ?? 'Select', sections };
  }

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v : undefined;
  }

  private obj(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  }
}

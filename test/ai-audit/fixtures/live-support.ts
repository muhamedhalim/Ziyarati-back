/**
 * AI chatbot audit (2026-09) — LIVE-model support. TEST INFRASTRUCTURE ONLY.
 *
 * Everything here is used by `live-*.spec.ts`, which run only when
 * `OPENAI_LIVE_TESTS=true` and a key is present. Live output varies run to run:
 * these suites assert BEHAVIOUR (which tool, which tenant, no write without
 * required data, no code/leak in the reply), never exact wording, and every
 * transcript is saved for human review.
 *
 * The API key is read from the environment / `.env` by the app's own
 * ConfigService; nothing in this file or its output ever contains it.
 */
import { performance } from 'node:perf_hooks';

import {
  AI_COMPLETION_PROVIDERS,
  type AiCompletionChunk,
  type AiCompletionProvider,
  type AiCompletionRequest,
  type AiCompletionResult,
} from '../../../src/modules/ai/providers/ai-provider.interface';
import { OpenAiChatProvider } from '../../../src/modules/ai/providers/openai-chat.provider';
import { OpenAiEmbeddingProvider } from '../../../src/modules/ai/providers/openai-embedding.provider';
import { ConfigService } from '@nestjs/config';
import { OpenAiClientProvider } from '../../../src/modules/ai/providers/openai-client.provider';
import { QueueService } from '../../../src/queue/queue.service';
import { MetricsService } from '../../../src/metrics/metrics.service';
import { AiCostLedgerService } from '../../../src/modules/ai/cost/ai-cost-ledger.service';
import { WhatsappBotActorService } from '../../../src/modules/whatsapp/whatsapp-bot-actor.service';
import { PublicBookingContextService } from '../../../src/modules/public-booking/public-booking-context.service';
import { bootAudit, gatewayTurn, mintGuest, whatsappTurn, type AuditRuntime } from './audit-runtime';
import type { AuditClinic } from './audit-seed';
import type { AuthenticatedUser } from '../../../src/modules/auth/interfaces/authenticated-user.interface';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface RecordedCall {
  index: number;
  ms: number;
  requestModel?: string;
  resolvedModel?: string;
  temperatureSent?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  toolsOffered: string[];
  toolResultsGiven: { name?: string; json: unknown }[];
  promptTokens: number;
  completionTokens: number;
  content: string;
  toolCalls: { name: string; args: unknown }[];
  /** whether ANY message in this request carried today's date (UTC or Riyadh) */
  sawTodayDate: boolean;
}

const parse = (s: string | null): unknown => {
  try { return JSON.parse(s ?? 'null'); } catch { return s; }
};

/** Wraps the REAL provider: records every call and enforces a hard cap on provider calls (cost guard). */
export class RecordingProvider implements AiCompletionProvider {
  readonly calls: RecordedCall[] = [];
  readonly name: string;
  constructor(private readonly inner: AiCompletionProvider, private readonly cap: number) {
    this.name = inner.name;
  }
  supports(model?: string): boolean { return this.inner.supports(model); }

  private guard(): void {
    if (this.calls.length >= this.cap) throw new Error(`LIVE BUDGET EXCEEDED: ${this.cap} provider calls`);
  }
  private record(req: AiCompletionRequest, t0: number, out: { content: string; model?: string; promptTokens: number; completionTokens: number; toolCalls?: { name: string; arguments: string }[] }): void {
    this.calls.push({
      index: this.calls.length,
      ms: Math.round(performance.now() - t0),
      requestModel: req.model,
      resolvedModel: out.model,
      temperatureSent: req.supportsTemperature === false ? undefined : req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      reasoningEffort: req.reasoningEffort,
      toolsOffered: (req.tools ?? []).map((t) => t.name),
      toolResultsGiven: req.messages.filter((m) => m.role === 'tool').map((m) => ({ name: m.name, json: parse(m.content) })),
      promptTokens: out.promptTokens,
      completionTokens: out.completionTokens,
      content: out.content,
      toolCalls: (out.toolCalls ?? []).map((c) => ({ name: c.name, args: parse(c.arguments) })),
      sawTodayDate: req.messages.some((m) => (m.content ?? '').includes(new Date().toISOString().slice(0, 10)) || (m.content ?? '').includes(new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10))),
    });
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    this.guard();
    const t0 = performance.now();
    const res = await this.inner.complete(req);
    this.record(req, t0, res);
    return res;
  }

  async *stream(req: AiCompletionRequest): AsyncIterable<AiCompletionChunk> {
    this.guard();
    const t0 = performance.now();
    let content = '';
    let last: AiCompletionChunk | undefined;
    for await (const chunk of this.inner.stream!(req)) {
      content += chunk.delta ?? '';
      if (chunk.done) last = chunk;
      yield chunk;
    }
    this.record(req, t0, {
      content,
      model: last?.model,
      promptTokens: last?.usage?.promptTokens ?? 0,
      completionTokens: last?.usage?.completionTokens ?? 0,
      toolCalls: last?.toolCalls,
    });
  }
}


/** The real embedder, built from the app's own services (the class is only registered under a token the harness overrides). */
function realEmbedder(rt: AuditRuntime): OpenAiEmbeddingProvider {
  const app = rt.harness.app;
  return new OpenAiEmbeddingProvider(
    app.get(ConfigService),
    app.get(QueueService, { strict: false }),
    app.get(AiCostLedgerService, { strict: false }),
    app.get(OpenAiClientProvider, { strict: false }),
    app.get(MetricsService, { strict: false }),
  );
}

export interface LiveRuntime extends AuditRuntime {
  recording: RecordingProvider;
}

/** The live gate: explicit opt-in AND a key. Evaluated lazily so `.env` loading order cannot fool it. */
export const liveEnabled = (): boolean => process.env.OPENAI_LIVE_TESTS === 'true' && !!process.env.OPENAI_API_KEY;

/** Boots the audit runtime with the REAL chat model and REAL embeddings; Meta and email stay stubbed. */
export async function bootLive(providerCallCap = 260): Promise<LiveRuntime> {
  if (!liveEnabled()) throw new Error('live suites need OPENAI_LIVE_TESTS=true and OPENAI_API_KEY');
  const rt = await bootAudit();
  const real = rt.harness.app.get(OpenAiChatProvider, { strict: false });
  const recording = new RecordingProvider(real, providerCallCap);
  rt.use(recording);

  // TEST-INFRASTRUCTURE WORKAROUND for audit finding F-25 — NOT a fix, and never applied to production code.
  // `WhatsappBotActorService.ensureBotActor` throws ROLE_ALREADY_EXISTS whenever its 60 s principal cache is
  // cold and the tenant's bot role already exists (proven in det-07-bot-actor.spec.ts), which silences every
  // WhatsApp/public-booking turn after the first minute. Without this memo the live run would measure that
  // bug instead of the model. The det-* suites deliberately do NOT use it, so they keep observing the defect.
  const botActor = rt.harness.app.get(WhatsappBotActorService);
  const originalEnsure = botActor.ensureBotActor.bind(botActor);
  const memo = new Map<string, Awaited<ReturnType<typeof originalEnsure>>>();
  jest.spyOn(botActor, 'ensureBotActor').mockImplementation(async (tenantId: string) => {
    const hit = memo.get(tenantId);
    if (hit) return hit;
    const principal = await originalEnsure(tenantId);
    memo.set(tenantId, principal);
    return principal;
  });

  // Real query embeddings (the harness force-scripts them so ordinary specs can never spend money).
  const realEmb = realEmbedder(rt);
  jest.spyOn(rt.harness.embedding, 'embed').mockImplementation((tenantId, texts, ctx) => realEmb.embed(tenantId, texts, ctx));
  return Object.assign(rt, { recording });
}

/** Real embeddings for a clinic's KB rows, inserted exactly where ingestion would put them. */
export async function embedKnowledge(rt: LiveRuntime, clinic: AuditClinic): Promise<number> {
  const realEmb = realEmbedder(rt);
  const rows: { id: string; content: string }[] = await rt.harness.dataSource.query(`SELECT id, content FROM ai_knowledge_bases WHERE "tenantId" = $1`, [clinic.tenantId]);
  for (const row of rows) {
    const { vectors } = await realEmb.embed(clinic.tenantId, [row.content], { kind: 'CONTENT', feature: 'audit_seed', route: 'audit', channel: 'INTERNAL' });
    await rt.harness.dataSource.query(
      `INSERT INTO ai_kb_embeddings (kb_id, tenant_id, agent_id, embedding) VALUES ($1,$2,NULL,$3::vector)`,
      [row.id, clinic.tenantId, `[${vectors[0].join(',')}]`],
    );
  }
  return rows.length;
}

// ─────────────────────────────── conversations ────────────────────────────── //

export interface TurnTrace {
  reply: string;
  tools: { name: string; args: unknown }[];
  toolResults: { name?: string; json: any }[];
  model?: string;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  providerCalls: number;
  errors: unknown[];
  sawTodayDate: boolean;
  /** Nest warn/error lines emitted during this turn (why a turn was silent) */
  logs: string[];
}

function traceSince(rt: LiveRuntime, mark: number, reply: string, errors: unknown[] = [], logs: string[] = []): TurnTrace {
  const calls = rt.recording.calls.slice(mark);
  return {
    reply,
    tools: calls.flatMap((c) => c.toolCalls),
    toolResults: (calls[calls.length - 1]?.toolResultsGiven ?? []) as { name?: string; json: any }[],
    model: calls[calls.length - 1]?.resolvedModel,
    promptTokens: calls.reduce((s, c) => s + c.promptTokens, 0),
    completionTokens: calls.reduce((s, c) => s + c.completionTokens, 0),
    ms: calls.reduce((s, c) => s + c.ms, 0),
    providerCalls: calls.length,
    errors,
    sawTodayDate: calls.some((c) => c.sawTodayDate),
    logs,
  };
}

/** A guest whose clinic/branch/service/doctor selection is pre-established SERVER-SIDE (what earlier turns would have written). */
export class LiveGuest {
  private constructor(private rt: LiveRuntime, private user: AuthenticatedUser, private conversationId: string) {}

  static async start(
    rt: LiveRuntime,
    selection: { clinic?: AuditClinic; branchId?: string; serviceIds?: string[]; doctorId?: string } = {},
  ): Promise<LiveGuest> {
    const user = await mintGuest(rt.harness);
    const ctxSvc = rt.harness.app.get(PublicBookingContextService);
    const conversationId = await ctxSvc.ensureConversation(rt.discoveryTenantId, user.id);
    if (selection.clinic) {
      await ctxSvc.patchSelection(rt.discoveryTenantId, conversationId, {
        selectedClinicId: selection.clinic.tenantId,
        selectedBranchId: selection.branchId ?? selection.clinic.branchId,
        selectedServiceIds: selection.serviceIds,
        selectedDoctorId: selection.doctorId,
      });
    }
    return new LiveGuest(rt, user, conversationId);
  }

  async say(text: string): Promise<TurnTrace> {
    const mark = this.rt.recording.calls.length;
    const logMark = this.rt.logs.length;
    const r = await gatewayTurn(this.rt, this.user, { content: text, aiConversationId: this.conversationId, channel: 'WEBSITE' });
    return traceSince(this.rt, mark, r.reply, r.errors, this.rt.logs.slice(logMark));
  }
}

export class LiveWhatsapp {
  constructor(private rt: LiveRuntime, private clinic: AuditClinic, readonly waId: string) {}
  async say(text: string): Promise<TurnTrace> {
    const mark = this.rt.recording.calls.length;
    const logMark = this.rt.logs.length;
    const r = await whatsappTurn(this.rt, this.clinic.tenantId, this.waId, text);
    return traceSince(this.rt, mark, r.replies.join('\n'), [], this.rt.logs.slice(logMark));
  }
}

// ─────────────────────────────── transcripts ──────────────────────────────── //

export interface Check { name: string; pass: boolean; note?: string }
export interface TranscriptEntry {
  scenario: string;
  surface: 'public' | 'whatsapp';
  turns: { user: string; trace: TurnTrace }[];
  checks: Check[];
}

export class Transcript {
  readonly entries: TranscriptEntry[] = [];
  add(entry: TranscriptEntry): TranscriptEntry { this.entries.push(entry); return entry; }
  save(name: string, extra: Record<string, unknown> = {}): void {
    const dir = join(__dirname, '..', 'results');
    mkdirSync(dir, { recursive: true });
    const summary = {
      scenarios: this.entries.length,
      checks: this.entries.flatMap((e) => e.checks).length,
      passed: this.entries.flatMap((e) => e.checks).filter((c) => c.pass).length,
      ...extra,
    };
    const body = JSON.stringify({ summary, entries: this.entries }, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `${name}.json`), body, 'utf8'); // latest
    writeFileSync(join(dir, `${name}-${stamp}.json`), body, 'utf8'); // never overwritten
  }
}

// ─────────────────────────────── heuristics ───────────────────────────────── //

/** Fraction of letters that are Arabic script. */
export const arabicRatio = (s: string): number => {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /[؀-ۿ]/.test(c)).length / letters.length;
};

export const hasCode = (s: string): boolean => /```|\bdef \w+\(|\bimport \w+|\bSELECT\b.+\bFROM\b|=>\s*\{|function\s+\w+\s*\(|@Controller|console\.log/i.test(s);

/** 24h HH:MM tokens in a reply. */
export const clockTimes = (s: string): string[] => (s.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g) ?? []).map((t) => t.padStart(5, '0'));

export const WRITE_TOOLS = ['book_appointment', 'book_public_appointment', 'cancel_appointment', 'reschedule_appointment', 'request_human_handover'];

export { AI_COMPLETION_PROVIDERS };

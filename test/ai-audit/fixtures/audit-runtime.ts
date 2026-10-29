/**
 * AI chatbot audit (2026-09) — shared runtime for every spec in `test/ai-audit`.
 *
 * TEST INFRASTRUCTURE ONLY. Reuses `buildAiAuditHarness` (real AppModule, real
 * Postgres/Redis, embeddings force-scripted so a live run can never make a real
 * embeddings call). Adds:
 *   - three-clinic seed (`audit-seed.ts`)
 *   - drivers that go through the SAME entry points production uses:
 *       guest widget  → `AiRealtimeGateway.onMessage` (real gateway handler, fake socket)
 *       WhatsApp      → `WhatsappInboundAiService.handleInboundValue` (real webhook bridge,
 *                       real per-tenant bot actor; only the OUTBOUND Meta send is captured)
 *       staff         → `AiRealtimeGateway.onMessage` with a staff principal
 *   - a live-provider swap (real `OpenAiChatProvider`) gated on OPENAI_LIVE_TESTS=true
 *   - a per-turn recorder that writes JSON evidence to `results/`
 *
 * The API key is read from the process environment only and is never written
 * to any file this module produces.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'socket.io';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { buildAiAuditHarness, type AiAuditHarness } from '../../security/fixtures/ai-audit-harness';
import { ScriptedAiProvider, type ScriptedTurn } from '../../security/fixtures/scripted-ai-provider';
import { seedAuditClinics, teardownAuditClinics, type AuditSeed, type AuditClinic } from './audit-seed';

import { AiRealtimeGateway } from '../../../src/modules/ai-realtime/ai-realtime.gateway';
import { WsAuthService } from '../../../src/modules/ai-realtime/ws-auth.service';
import { AiConversationService } from '../../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, type ToolContext } from '../../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_COMPLETION_PROVIDERS, type AiCompletionProvider, type AiCompletionRequest } from '../../../src/modules/ai/providers/ai-provider.interface';
import { WhatsappInboundAiService } from '../../../src/modules/whatsapp/whatsapp-inbound-ai.service';
import { WhatsappBotActorService } from '../../../src/modules/whatsapp/whatsapp-bot-actor.service';
import { WhatsappMessagingService } from '../../../src/modules/whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../../../src/modules/whatsapp/routing/whatsapp-message.router';
import { TenantContextService } from '../../../src/core/tenant-context/tenant-context.service';
import { ConversationSessionService } from '../../../src/modules/ai-orchestrator/conversation-session.service';
import type { AuthenticatedUser } from '../../../src/modules/auth/interfaces/authenticated-user.interface';
import type { MetaWebhookChangeValue } from '../../../src/modules/whatsapp/webhooks/whatsapp-webhook.types';

export interface TurnRecord {
  surface: 'public' | 'whatsapp' | 'staff';
  scenario: string;
  input: string;
  reply: string;
  tools: string[];
  toolArgs: { name: string; args: unknown }[];
  errors: unknown[];
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  ms: number;
}

export interface AuditRuntime {
  harness: AiAuditHarness;
  seed: AuditSeed;
  discoveryTenantId: string;
  dispatch: AiToolDispatchService;
  conversations: AiConversationService;
  tenantCtx: TenantContextService;
  provider: ScriptedAiProvider;
  /** every outbound WhatsApp text the bridge tried to send (Meta is never called) */
  whatsappOutbox: { tenantId: string; to: string; text: string }[];
  records: TurnRecord[];
  /** Nest Logger warn/error lines emitted while a test ran (silent-failure evidence). */
  logs: string[];
  /** Swap the ONLY registered completion provider (scripted by default). */
  use(provider: AiCompletionProvider): void;
  close(): Promise<void>;
}

export async function bootAudit(): Promise<AuditRuntime> {
  const harness = await buildAiAuditHarness();
  const seed = await seedAuditClinics(harness.dataSource);

  const discoveryRow = await harness.dataSource.query(`SELECT id FROM tenants WHERE slug = '__guest_discovery__'`);
  let discoveryTenantId: string = discoveryRow[0]?.id;
  if (!discoveryTenantId) {
    // first guest session creates it — mint one so the id exists
    await mintGuest(harness);
    discoveryTenantId = (await harness.dataSource.query(`SELECT id FROM tenants WHERE slug = '__guest_discovery__'`))[0].id;
  }

  // ── WhatsApp outbound capture: Meta is NEVER called ─────────────────────
  const whatsappOutbox: AuditRuntime['whatsappOutbox'] = [];
  const messaging = harness.app.get(WhatsappMessagingService);
  const router = harness.app.get(WhatsappMessageRouter);
  jest.spyOn(router, 'resolveForSend').mockImplementation(async () => ({ id: 'audit-account', phoneNumberId: 'audit-pnid', mode: 'COEXISTENCE' }) as never);
  jest.spyOn(messaging, 'sendSession').mockImplementation(async (a: { tenantId: string; to: string; text: string }) => {
    whatsappOutbox.push({ tenantId: a.tenantId, to: a.to, text: a.text });
    return { success: true, providerMessageId: `wamid.audit-${whatsappOutbox.length}` } as never;
  });

  const logs: string[] = [];
  const grab = (level: string) => function (this: unknown, message: unknown, ...rest: unknown[]) {
    logs.push(`[${level}] ${typeof message === 'string' ? message : JSON.stringify(message)} ${rest.filter((r) => typeof r === 'string').join(' ')}`.slice(0, 400));
  };
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(grab('warn') as never);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(grab('error') as never);

  const runtime: AuditRuntime = {
    harness,
    seed,
    discoveryTenantId,
    dispatch: harness.app.get(AiToolDispatchService),
    conversations: harness.app.get(AiConversationService),
    tenantCtx: harness.app.get(TenantContextService),
    provider: harness.provider,
    whatsappOutbox,
    records: [],
    logs,
    use: (provider) => {
      const arr = harness.app.get(AI_COMPLETION_PROVIDERS);
      arr.length = 0;
      arr.push(provider);
    },
    close: async () => {
      jest.restoreAllMocks();
      await teardownAuditClinics(harness.dataSource, seed);
      await harness.close();
    },
  };
  return runtime;
}

// ─────────────────────────────── guest / public ────────────────────────────── //

export async function mintGuest(harness: AiAuditHarness): Promise<AuthenticatedUser> {
  const res = await request(harness.app.getHttpServer()).post('/api/v1/public/guest/session').send({}).expect(200);
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const guestCookie = cookies?.find((c) => c.startsWith('guest_token='));
  if (!guestCookie) throw new Error('guest_token cookie was not issued');
  return harness.app.get(WsAuthService).authenticate({
    handshake: { auth: {}, headers: { cookie: guestCookie.split(';')[0] }, query: {} },
  } as unknown as Socket);
}

export interface FakeSocket extends Socket {
  emitted: { event: string; payload: any }[];
}

/**
 * `address` is the network address the transport reports (`socket.handshake.address`).
 * Omitted, the handshake carries none — as the earlier suites always did — so the
 * per-address guest tier (F-16) has nothing to key on and is skipped.
 */
export function fakeSocket(user: AuthenticatedUser, address?: string): FakeSocket {
  const emitted: { event: string; payload: any }[] = [];
  return {
    data: { tenantId: user.tenantId, userId: user.id, user },
    handshake: { address, auth: {}, headers: {}, query: {} },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    },
    join: () => undefined,
    to: () => ({ emit: () => true }),
    rooms: new Set<string>(),
    emitted,
  } as unknown as FakeSocket;
}

export interface TurnResult {
  reply: string;
  aiConversationId?: string;
  tools: string[];
  errors: any[];
  raw: { event: string; payload: any }[];
}

/** One turn through the REAL gateway handler under a given principal. */
export async function gatewayTurn(
  rt: AuditRuntime,
  user: AuthenticatedUser,
  body: { content: string; aiConversationId?: string; channel?: string },
  address?: string,
): Promise<TurnResult> {
  const gateway = rt.harness.app.get(AiRealtimeGateway);
  const socket = fakeSocket(user, address);
  await rt.tenantCtx.run(async () => {
    rt.tenantCtx.setPrincipal(user);
    return gateway.onMessage(socket, body as never);
  });
  const done = socket.emitted.find((e) => e.event === 'ai:done')?.payload;
  return {
    reply: done?.reply?.content ?? '',
    aiConversationId: done?.aiConversationId,
    tools: socket.emitted.filter((e) => e.event === 'ai:tool' && e.payload.phase !== 'done').map((e) => e.payload.name),
    errors: socket.emitted.filter((e) => e.event === 'ai:error').map((e) => e.payload),
    raw: socket.emitted,
  };
}

/** A multi-turn guest session pinned to one guest principal + conversation. */
export class GuestSession {
  conversationId?: string;
  private constructor(private rt: AuditRuntime, readonly user: AuthenticatedUser, private address?: string) {}
  static async start(rt: AuditRuntime, address?: string): Promise<GuestSession> {
    return new GuestSession(rt, await mintGuest(rt.harness), address);
  }
  async say(content: string, channel = 'WEBSITE'): Promise<TurnResult> {
    const r = await gatewayTurn(this.rt, this.user, { content, aiConversationId: this.conversationId, channel }, this.address);
    this.conversationId = r.aiConversationId ?? this.conversationId;
    return r;
  }
  /** Reads the server-side selection the tools have recorded for this guest. */
  async session(): Promise<Record<string, unknown>> {
    const rows = await this.rt.harness.dataSource.query(`SELECT session FROM ai_conversations WHERE id = $1`, [this.conversationId]);
    return rows[0]?.session ?? {};
  }
  /** ToolContext exactly as `AiExecutionService` builds it for a guest turn (ai-execution.service.ts:605-616). */
  toolCtx(): ToolContext {
    return {
      tenantId: this.user.tenantId as string, // a guest principal always carries its clinic's tenant
      actorUserId: this.user.id, // <- the line under audit (H3): the guest subject, never empty
      permissions: this.user.permissions ?? [],
      aiConversationId: this.conversationId!,
      principal: this.user,
    };
  }
}

/** A clinic OWNER principal carrying the real system-role permission set from the DB. */
export async function ownerPrincipal(rt: AuditRuntime, clinic: AuditClinic): Promise<AuthenticatedUser> {
  const perms: { slug: string }[] = await rt.harness.dataSource.query(
    `SELECT p.slug FROM role_permissions rp JOIN permissions p ON p.id = rp."permissionId"
       JOIN roles r ON r.id = rp."roleId" WHERE r.slug = 'owner' AND r."tenantId" IS NULL`,
  );
  return {
    id: clinic.doctorUserIds.omar ?? Object.values(clinic.doctorUserIds)[0],
    tenantId: clinic.tenantId,
    email: null,
    roles: ['owner'],
    permissions: perms.map((p) => p.slug),
  } as unknown as AuthenticatedUser;
}

// ─────────────────────────────────── WhatsApp ──────────────────────────────── //

export function waPayload(text: string, waId: string, name = 'Audit Patient', phoneNumberId?: string): MetaWebhookChangeValue {
  return {
    // The receiving number: without it no account (so no timeline thread) can be resolved and the bot stays silent.
    ...(phoneNumberId ? { metadata: { phone_number_id: phoneNumberId } } : {}),
    messages: [{ id: `wamid.audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, from: waId, type: 'text', text: { body: text } }],
    contacts: [{ wa_id: waId, profile: { name } }],
  } as unknown as MetaWebhookChangeValue;
}

export async function whatsappTurn(rt: AuditRuntime, tenantId: string, waId: string, text: string): Promise<{ replies: string[]; tools: string[] }> {
  const before = rt.whatsappOutbox.length;
  const toolsBefore = await rt.harness.dataSource.query(`SELECT count(*)::int c FROM ai_tool_calls WHERE tenant_id = $1`, [tenantId]);
  await rt.harness.app.get(WhatsappInboundAiService).handleInboundValue(
    tenantId,
    waPayload(text, waId, 'Audit Patient', [rt.seed.full, rt.seed.empty, rt.seed.b].find((c) => c.tenantId === tenantId)?.phoneNumberId),
  );
  const tools = await rt.harness.dataSource.query(
    `SELECT tool_name FROM ai_tool_calls WHERE tenant_id = $1 ORDER BY created_at ASC OFFSET $2`,
    [tenantId, toolsBefore[0].c],
  );
  return { replies: rt.whatsappOutbox.slice(before).filter((o) => o.tenantId === tenantId).map((o) => o.text), tools: tools.map((t: { tool_name: string }) => t.tool_name) };
}

/** ToolContext for a WhatsApp turn on `clinic`, bound to `customerId`, using the REAL per-tenant bot actor. */
export async function whatsappToolCtx(rt: AuditRuntime, clinic: AuditClinic, customerId: string | undefined): Promise<ToolContext> {
  const bot = await rt.harness.app.get(WhatsappBotActorService).ensureBotActor(clinic.tenantId);
  const conv = await rt.conversations.start(clinic.tenantId, {});
  if (customerId) await rt.harness.app.get(ConversationSessionService).patch(clinic.tenantId, conv.id, { context: { customerId } } as never);
  return {
    tenantId: clinic.tenantId,
    actorUserId: bot.id,
    permissions: bot.permissions,
    customerId,
    aiConversationId: conv.id,
    principal: bot,
  };
}

// ─────────────────────────────────── recording ─────────────────────────────── //

export function scriptTurns(rt: AuditRuntime, turns: ScriptedTurn[]): void {
  rt.provider.reset();
  rt.provider.script(turns);
}

export function providerRequests(rt: AuditRuntime): readonly AiCompletionRequest[] {
  return rt.provider.capturedRequests;
}

export function saveEvidence(name: string, data: unknown): void {
  const dir = join(__dirname, '..', 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Runs `fn` with config values overridden, then restores them.
 *
 * `ConfigService.set` cannot do this: with env validation on, `get` answers from the
 * validated-env snapshot first, and every key with a Joi default is in it. So the
 * snapshot itself is edited, and put back in `finally`.
 */
export async function withConfig<T>(rt: AuditRuntime, values: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const config = rt.harness.app.get(ConfigService) as unknown as { internalConfig: Record<string, Record<string, unknown> | undefined> };
  const snapshot = (config.internalConfig['_PROCESS_ENV_VALIDATED'] ??= {}) as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, { had: k in snapshot, value: snapshot[k] }]));
  Object.assign(snapshot, values);
  try {
    return await fn();
  } finally {
    for (const [k, b] of Object.entries(before)) {
      if (b.had) snapshot[k] = b.value;
      else delete snapshot[k];
    }
  }
}

/**
 * Days searched by an availability call that must contain an open day after today.
 *
 * The seeded clinics are closed Fri/Sat. The tool searches today..today+(daysAhead-1) and, when that
 * window holds no bookable day, answers with an EMPTY `days` and puts the first open days in
 * `nextAvailable`. A short window (the specs used 3) is therefore empty on a Thursday after the
 * last slot of the day — and the spec, not the product, breaks. Seven days always spans a weekend
 * and the open days around it, so `days` is populated on every weekday and at every hour.
 */
export const AVAILABILITY_HORIZON_DAYS = 7;

/**
 * The first availability day AFTER today in the clinic's zone (Asia/Riyadh in the seed).
 *
 * Today's grid is only the part of the day still ahead of the booking lead time, so it is short, or
 * absent, whenever a suite runs after the clinic's opening hour (09:00). A spec that picks a slot by
 * index, or counts a day's slots, therefore judges the first FULL day instead of `days[0]`, so it
 * gives the same answer at 03:00 and at 15:00.
 *
 * The caller must have searched `AVAILABILITY_HORIZON_DAYS`; if it did not and the window held no open
 * day, the error says so (and shows `nextAvailable`) instead of reporting a bare "no day".
 */
export function firstFullDay<T extends { date: string }>(days: readonly T[], answer?: { nextAvailable?: unknown }): T {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  const day = days.find((d) => d.date > today);
  if (!day) {
    throw new Error(
      `no availability day after ${today} in \`days\`: ${JSON.stringify(days.map((d) => d.date))}` +
        (answer?.nextAvailable ? `; nextAvailable=${JSON.stringify(answer.nextAvailable)}` : '') +
        ` — search at least AVAILABILITY_HORIZON_DAYS (${AVAILABILITY_HORIZON_DAYS}) days ahead`,
    );
  }
  return day;
}

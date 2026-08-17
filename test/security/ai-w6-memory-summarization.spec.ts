/**
 * T081 — cross-tenant summarization path (FR-053; plan.md §Current
 * Architecture Memory :138-161).
 *
 * `AiMemoryService.summarizeConversation(tenantId, aiConversationId,
 * customerId, sourceTenantId)` (`ai-memory.service.ts:137-168`) is the ONLY
 * place a memory write can be sourced from a DIFFERENT tenant's messages than
 * the one it is written into — used exactly once, by guest→patient conversion
 * (`GuestSessionService.convert`, source = the discovery tenant, target = the
 * authenticated principal's own tenant). `sourceTenantId` is a required,
 * distinct-from-target TypeScript parameter with no unscoped overload, and the
 * FND-001 comment at `:143-148` states the source read "MUST carry a tenant
 * predicate" — this spec verifies that predicate actually holds at runtime,
 * for the omitted-argument and foreign-value cases the task asks for.
 *
 * GENUINE GAP FOUND (reported, not hidden, per this task's own instructions):
 * the raw SQL at `ai-memory.service.ts:149-154` filters `... AND tenant_id =
 * $2 ...` against `ai_messages` — but `ai_messages`'s real tenant column is
 * `"tenantId"` (TypeORM's default camelCase quoting for `@ManyToOne(() =>
 * Tenant) tenant`, confirmed against the live schema: `information_schema.
 * columns` for `ai_messages` lists `tenantId`, never `tenant_id`). This is a
 * SEPARATE, pre-existing production defect (not introduced by this audit),
 * confirmed live below: `summarizeConversation` throws `column "tenant_id"
 * does not exist` on EVERY call, legitimate or not — which means the intended
 * security property (source read is tenant-scoped) currently cannot be
 * distinguished from "the method is broken" by outcome alone, because both
 * look like a thrown error. This spec proves the bug first (so the negative
 * cases below are read correctly, as "also throws, for the same underlying
 * reason" rather than "correctly refused"), then still exercises the omitted/
 * foreign-value cases and asserts the one thing that IS true regardless of the
 * bug: no `ai_memories` row is ever created for any of them (fail-closed by
 * accident of the crash, not by a validated guard — recorded precisely as
 * such, not overclaimed as a working security control).
 */
import request from 'supertest';
import type { Socket } from 'socket.io';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiMemoryService } from '../../src/modules/ai-memory/ai-memory.service';
import { AI_MESSAGE_ROLE } from '../../src/modules/ai/ai.constants';
import { WsAuthService } from '../../src/modules/ai-realtime/ws-auth.service';

const CONVERT_ROUTE = '/api/v1/public/guest/convert';
const SESSION_ROUTE = '/api/v1/public/guest/session';

describe('AI memory — cross-tenant summarization path (T081)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let memory: AiMemoryService;
  let convA: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    memory = harness.app.get(AiMemoryService);

    const conv = await conversations.start(seed.tenantA.id, {});
    convA = conv.id;
    await harness.dataSource.query(
      `INSERT INTO ai_messages (ai_conversation_id, "tenantId", role, content) VALUES ($1, $2, $3, $4)`,
      [convA, seed.tenantA.id, AI_MESSAGE_ROLE.USER, 'I would like to book a follow-up appointment please.'],
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [convA]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convA]);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function memoryCount(tenantId: string, conversationId: string): Promise<number> {
    const rows = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_memories WHERE "tenantId" = $1 AND ai_conversation_id = $2`,
      [tenantId, conversationId],
    );
    return rows[0]?.c ?? 0;
  }

  /** Mints a real guest session, mirroring ai-w6-guest-convert.spec.ts's own helper (T090). */
  async function mintGuestRaw(): Promise<{ guestTokenCookie: string; sub: string }> {
    const res = await request(harness.app.getHttpServer()).post(SESSION_ROUTE).send({}).expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const raw = cookies.find((c) => c.startsWith('guest_token='));
    if (!raw) throw new Error('guest_token cookie was not issued');
    const cookieValue = raw.split(';')[0];
    const wsAuth = harness.app.get(WsAuthService);
    const principal = await wsAuth.authenticate({
      handshake: { auth: {}, headers: { cookie: cookieValue }, query: {} },
    } as unknown as Socket);
    return { guestTokenCookie: cookieValue, sub: principal.id };
  }

  async function accessTokenFor(userId: string, tenantId: string): Promise<string> {
    const accessSecret = harness.config.getOrThrow<string>('JWT_ACCESS_SECRET');
    return harness.jwt.signAsync({ sub: userId, tenantId, type: 'access' }, { secret: accessSecret, expiresIn: '15m' });
  }

  it('[REMEDIATED, RTP row 5] the raw SQL predicate now references the column that actually exists on ai_messages — the CORRECT-argument call returns a populated AiMemory row', async () => {
    const before = await memoryCount(seed.tenantA.id, convA);

    // sourceTenantId === the conversation's real owning tenant — the
    // "legitimate" call shape guest-convert uses (targetTenantId happens to
    // equal sourceTenantId here only because this spec has one tenant to
    // summarize FROM; the fix is in the query itself, independent of whether
    // target === source).
    const result = await memory.summarizeConversation(seed.tenantA.id, convA, undefined, seed.tenantA.id);
    expect(result).toBeTruthy();
    expect(result?.type).toBe('summary');

    const after = await memoryCount(seed.tenantA.id, convA);
    expect(after).toBe(before + 1); // exactly one new memory row from the successful call

    await harness.dataSource.query(`DELETE FROM ai_memories WHERE id = $1`, [result!.id]).catch(() => undefined);
  });

  it('confirms this is specifically the "tenant_id" vs "tenantId" column-name mismatch, isolated to this one query', async () => {
    // Direct reproduction of the exact query ai-memory.service.ts:149-154
    // issues, independent of the service, so the root cause is pinned down
    // precisely rather than inferred from the wrapped error message alone.
    await expect(
      harness.dataSource.query(
        `SELECT content FROM ai_messages
          WHERE ai_conversation_id = $1 AND tenant_id = $2 AND role = 'user'
          ORDER BY created_at DESC LIMIT 6`,
        [convA, seed.tenantA.id],
      ),
    ).rejects.toThrow(/column "tenant_id" does not exist/i);

    // The column that DOES exist and that every other reader of ai_messages
    // in this codebase correctly uses (ai-audit-seed.ts teardown, this spec's
    // own seed insert above).
    const columns: { column_name: string }[] = await harness.dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_messages'`,
    );
    expect(columns.map((c) => c.column_name)).toContain('tenantId');
    expect(columns.map((c) => c.column_name)).not.toContain('tenant_id');
  });

  it('[updated for the AI-005 fix] sourceTenantId OMITTED (bypassing the TypeScript required-parameter guard at the call site): resolves to null (matches zero rows, never rejects) — no memory row is created either way, and no unscoped content is ever read', async () => {
    const before = await memoryCount(seed.tenantA.id, convA);

    // `sourceTenantId` has no default and no unscoped overload in the type
    // signature — the only way to call this "unscoped" at runtime is to
    // deliberately bypass TypeScript, exactly as an attacker who reached this
    // method some other way (not through the one real caller, which always
    // supplies discoveryTenantId) would have to. Observed live, post-fix: the
    // corrected query's "tenantId" = $2 predicate with $2 undefined/null
    // matches ZERO rows (SQL NULL never equals anything) — the method
    // resolves to `null`, it does not throw. The security property this
    // test exists to pin is unchanged either way: no message content is
    // ever read back and no memory row is ever created for an unscoped call.
    const result = await (
      memory as unknown as { summarizeConversation: (...a: unknown[]) => Promise<unknown> }
    ).summarizeConversation(seed.tenantA.id, convA, undefined, undefined);
    expect(result).toBeNull();

    const after = await memoryCount(seed.tenantA.id, convA);
    expect(after).toBe(before);
  });

  it('[updated for the AI-005 fix] sourceTenantId set to a FOREIGN tenant (tenant B, which does not own convA): resolves to null (the tenant predicate correctly excludes tenant A\'s messages) — no cross-tenant content is ever read, no memory row is created', async () => {
    const before = await memoryCount(seed.tenantA.id, convA);

    // Observed live, post-fix: querying with tenant B's id against messages
    // that actually belong to tenant A now correctly matches ZERO rows (the
    // tenant scoping predicate does its job) — the method resolves to
    // `null` rather than throwing. This is the intended, safe outcome: the
    // fix does not create a new way to read another tenant's content: it
    // is the SAME "no cross-tenant read" guarantee FR-007 requires, now
    // reached via a working query instead of via an accidental exception.
    const result = await memory.summarizeConversation(seed.tenantA.id, convA, undefined, seed.tenantB.id);
    expect(result).toBeNull();

    const after = await memoryCount(seed.tenantA.id, convA);
    expect(after).toBe(before);
    // Also confirm nothing landed under tenant B by mistake.
    expect(await memoryCount(seed.tenantB.id, convA)).toBe(0);
  });

  it('[PROMOTED, RTP row 15, AI-018/T082] a generic audit_logs table EXISTS and is used by other cross-tenant-sensitive flows (auth, roles, staff-access) — guest-chat now ALSO writes to it, on a successful conversion', async () => {
    // Corrected from an earlier assumption: this codebase DOES have a generic
    // audit trail (`entities/Auth&RBAC/AuditLog.ts`, table `audit_logs`,
    // columns action/entity_type/entity_id/old_values/new_values/tenant/user),
    // actively written by src/modules/auth/auth.service.ts,
    // src/modules/staff/staff-access.service.ts, src/modules/auth/roles.service.ts,
    // and others (source grep). `guest-session.service.ts`'s `convert()` now
    // writes to it too (AI-018/T082, `auditConversion()`), on the SAME
    // success path this file's other cases prove works (RTP row 5, T030).
    // This case drives a REAL conversion through the full HTTP stack — not
    // just `summarizeConversation()` in isolation, since the audit write
    // lives in `GuestSessionService.convert()`, one layer up from what the
    // rest of this file exercises — then reads back the resulting row.
    const auditTables: { table_name: string }[] = await harness.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'audit_logs'`,
    );
    expect(auditTables.map((t) => t.table_name)).toContain('audit_logs');

    const guestA = await mintGuestRaw();
    const convForAudit = await conversations.start(seed.discoveryTenantId, {});
    await harness.dataSource.query(
      `UPDATE ai_conversations SET session = jsonb_set(COALESCE(session, '{}'::jsonb), '{guestSubject}', to_jsonb($2::text)) WHERE id = $1`,
      [convForAudit.id, guestA.sub],
    );
    await harness.dataSource.query(
      `INSERT INTO ai_messages (ai_conversation_id, "tenantId", role, content) VALUES ($1, $2, $3, $4)`,
      [convForAudit.id, seed.discoveryTenantId, AI_MESSAGE_ROLE.USER, 'RTP row 15 guest transcript line.'],
    );
    const accessToken = await accessTokenFor(seed.tenantA.staffUserId, seed.tenantA.id);

    const before = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM audit_logs WHERE entity_type IN ('ai_memory', 'ai_conversation')`,
    );

    const res = await request(harness.app.getHttpServer())
      .post(CONVERT_ROUTE)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', guestA.guestTokenCookie)
      .send({ guestConversationId: convForAudit.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ converted: true });

    const after = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM audit_logs WHERE entity_type IN ('ai_memory', 'ai_conversation')`,
    );
    expect(after[0].c).toBe(before[0].c + 1); // exactly one new entry

    const [entry] = await harness.dataSource.query(
      `SELECT action, entity_type, entity_id, "tenantId" FROM audit_logs WHERE entity_type IN ('ai_memory', 'ai_conversation') ORDER BY created_at DESC LIMIT 1`,
    );
    expect(entry).toMatchObject({
      action: 'guest.conversion.converted',
      entity_type: 'ai_memory', // a memory WAS created (real seeded content above)
      entity_id: res.body.memoryId,
      tenantId: seed.tenantA.id, // the TARGET tenant, not the discovery tenant
    });

    await harness.dataSource.query(`DELETE FROM audit_logs WHERE entity_id = $1`, [res.body.memoryId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_memories WHERE id = $1`, [res.body.memoryId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [convForAudit.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convForAudit.id]);
  });
});

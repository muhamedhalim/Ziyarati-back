/**
 * T158 — AI analytics/metrics exposure (FR-022, FR-083).
 *
 * Requests every HTTP-exposed AI analytics/metrics endpoint AS TENANT A and
 * asserts each returned aggregate is EXACTLY derivable from tenant-A-only
 * activity — never inflated, joined, or contaminated by tenant B's,
 * concurrently-seeded, much larger activity. Tenant B's turns are scripted
 * with deliberately huge, distinctive token counts (9,000/900, times 3 turns)
 * specifically so that ANY cross-tenant leak into tenant A's numbers would be
 * impossible to miss (a subtle off-by-one leak would not require such large
 * numbers; a real query-scoping bug would).
 *
 * Complements, not duplicates, `src/modules/ai/ai-analytics.cost-isolation.spec.ts`:
 * that file is a plain Jest unit test (no Nest module, no HTTP, a HAND-MOCKED
 * `DataSource.query` stub) asserting the SQL text of `AiAnalyticsService.
 * costAttribution()` contains `WHERE tenant_id=$1` bound first — and
 * `costAttribution` (along with its sibling `cost()`) is not even wired to any
 * controller route (confirmed by reading `ai-analytics.controller.ts` end to
 * end — only `usage`/`conversations`/`agents`/`knowledge` are `@Get()`
 * routes). This file exercises the DIFFERENT, ACTUALLY HTTP-REACHABLE surface
 * — `AiAnalyticsController`'s 4 routes and `AiMetricsController`'s 2 routes —
 * against a REAL Postgres with REAL multi-tenant data, over REAL HTTP calls
 * with a REAL JWT, checked field-by-field against known seed cardinality
 * rather than SQL-text pattern matching.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';

import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';

import { User } from '../../src/entities/Auth&RBAC/User';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';

import { ROLE, ROLE_PERMISSIONS } from '../../src/rbac/rbac.constants';

describe('W10 — AI analytics/metrics exposure: tenant-A-only derivability (T158)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let accessSecret: string;
  let ownerUserId: string;
  let token: string;

  const convIds: string[] = [];

  // Deterministic, known-cardinality activity per tenant.
  const A_TURNS = [
    { promptTokens: 100, completionTokens: 20 }, // 120
    { promptTokens: 50, completionTokens: 10 }, // 60
  ];
  const A_TOTAL_TOKENS = A_TURNS.reduce((s, t) => s + t.promptTokens + t.completionTokens, 0); // 180
  const A_TOTAL_REQUESTS = A_TURNS.length; // 2

  // Deliberately huge + distinctive so any leak into tenant A's totals is unmissable.
  const B_TURNS = [
    { promptTokens: 9000, completionTokens: 900 },
    { promptTokens: 9000, completionTokens: 900 },
    { promptTokens: 9000, completionTokens: 900 },
  ];
  const B_TOTAL_TOKENS = B_TURNS.reduce((s, t) => s + t.promptTokens + t.completionTokens, 0); // 29700

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    accessSecret = harness.config.getOrThrow<string>('JWT_ACCESS_SECRET');

    const ds = harness.dataSource;
    const users = ds.getRepository(User);
    const roles = ds.getRepository(Role);
    const userRoles = ds.getRepository(UserRole);
    const ownerUser = await users.save(
      users.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        email: `w10-analytics-owner-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'W10 Analytics Owner',
        is_active: true,
      }),
    );
    ownerUserId = ownerUser.id;
    const ownerRole = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.OWNER })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!ownerRole) throw new Error('seeded system role "owner" not found — run the RBAC seed first.');
    await userRoles.save(userRoles.create({ user: { id: ownerUser.id } as User, role: { id: ownerRole.id } as Role }));
    token = await harness.jwt.signAsync(
      { sub: ownerUser.id, tenantId: seed.tenantA.id, type: 'access' },
      { secret: accessSecret, expiresIn: '15m' },
    );

    // Drive the known, plain (no tool call — one provider call per turn, so
    // token accounting is exact and simple) activity for both tenants.
    for (const t of A_TURNS) {
      const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
      convIds.push(conv.id);
      harness.provider.reset();
      harness.provider.script([{ content: 'tenant A scripted reply', promptTokens: t.promptTokens, completionTokens: t.completionTokens }]);
      await execution.sendMessage(seed.tenantA.id, conv.id, { content: 'hi from tenant A' }, 'REST');
    }
    for (const t of B_TURNS) {
      const conv = await conversations.start(seed.tenantB.id, { agentId: seed.tenantB.agentId });
      convIds.push(conv.id);
      harness.provider.reset();
      harness.provider.script([{ content: 'tenant B scripted reply', promptTokens: t.promptTokens, completionTokens: t.completionTokens }]);
      await execution.sendMessage(seed.tenantB.id, conv.id, { content: 'hi from tenant B' }, 'REST');
    }
  }, 120_000);

  afterAll(async () => {
    const ds = harness.dataSource;
    const q = (sql: string, params: unknown[]) => ds.query(sql, params).catch(() => undefined);
    await q(`DELETE FROM ai_execution_metrics WHERE ai_conversation_id::text = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_cost_entries WHERE ai_conversation_id::text = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [convIds]);
    await q(`DELETE FROM user_roles WHERE "userId" = $1`, [ownerUserId]);
    await q(`DELETE FROM users WHERE id = $1`, [ownerUserId]);

    await teardownAiAuditSeed(ds, seed);
    await harness.close();
  }, 60_000);

  /** No tenant-B identifier or tenant-B-scale number appears anywhere in the raw response body. */
  function assertNoTenantBLeak(body: unknown) {
    const blob = JSON.stringify(body);
    expect(blob).not.toContain(seed.tenantB.id);
    expect(blob).not.toContain(seed.tenantB.agentId);
    expect(blob).not.toContain(seed.tenantB.kbId);
    expect(blob).not.toContain('29700'); // B's total tokens — could only appear via a summed leak
    expect(blob).not.toContain('9000'); // B's per-turn prompt tokens
  }

  it('GET /ai/analytics/usage — totals, trend, and topAgents are tenant-A-only', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/api/v1/ai/analytics/usage')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(seed.tenantA.id);
    expect(res.body.totalTokens).toBe(A_TOTAL_TOKENS);
    expect(res.body.totalRequests).toBe(A_TOTAL_REQUESTS);
    expect(res.body.topAgents).toEqual([
      { agentId: seed.tenantA.agentId, tokens: A_TOTAL_TOKENS, requests: A_TOTAL_REQUESTS },
    ]);
    assertNoTenantBLeak(res.body);
  });

  it('GET /ai/analytics/conversations — totals match exactly the 2 conversations this run created for tenant A', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/api/v1/ai/analytics/conversations')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(seed.tenantA.id);
    expect(res.body.totalConversations).toBe(A_TURNS.length);
    expect(res.body.totalMessages).toBeGreaterThanOrEqual(A_TURNS.length); // >= user+assistant per turn
    assertNoTenantBLeak(res.body);
  });

  it('GET /ai/analytics/agents — per-agent totals + activeAgents count are tenant-A-only', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/api/v1/ai/analytics/agents')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(seed.tenantA.id);
    expect(res.body.activeAgents).toBe(1); // only tenant A's own seeded agent
    expect(res.body.agents).toEqual([
      { agentId: seed.tenantA.agentId, tokens: A_TOTAL_TOKENS, requests: A_TOTAL_REQUESTS },
    ]);
    assertNoTenantBLeak(res.body);
  });

  it('GET /ai/analytics/knowledge — chunk inventory is tenant-A-only (1 KB row from the seed fixture, not 2)', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/api/v1/ai/analytics/knowledge')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(seed.tenantA.id);
    expect(res.body.totalChunks).toBe(1);
    expect(res.body.byAgent).toEqual([{ agentId: seed.tenantA.agentId, chunks: 1 }]);
    assertNoTenantBLeak(res.body);
  });

  it('GET /ai/metrics/summary — request count and token sums are tenant-A-only', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/api/v1/ai/metrics/summary')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(seed.tenantA.id);
    expect(res.body.requests).toBe(A_TOTAL_REQUESTS);
    expect(res.body.tokens.total).toBe(A_TOTAL_TOKENS);
    expect(res.body.tokens.prompt).toBe(A_TURNS.reduce((s, t) => s + t.promptTokens, 0));
    expect(res.body.tokens.completion).toBe(A_TURNS.reduce((s, t) => s + t.completionTokens, 0));
    // byModel is present but must not carry more requests than tenant A drove.
    const modelTotal = (res.body.byModel as Array<{ requests: number }>).reduce((s, m) => s + m.requests, 0);
    expect(modelTotal).toBe(A_TOTAL_REQUESTS);
    assertNoTenantBLeak(res.body);
  });

  it('GET /ai/metrics/timeseries — daily series (a bare array, not wrapped in {tenantId,...}) sums to exactly tenant A\'s known totals', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/api/v1/ai/metrics/timeseries')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const series = res.body as Array<{ requests: number; tokens: number }>;
    expect(Array.isArray(series)).toBe(true);
    const totalRequests = series.reduce((s, d) => s + Number(d.requests), 0);
    const totalTokens = series.reduce((s, d) => s + Number(d.tokens), 0);
    expect(totalRequests).toBe(A_TOTAL_REQUESTS);
    expect(totalTokens).toBe(A_TOTAL_TOKENS);
    assertNoTenantBLeak(res.body);
  });
});

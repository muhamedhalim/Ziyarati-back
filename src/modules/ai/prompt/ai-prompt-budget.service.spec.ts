import { ConfigService } from '@nestjs/config';
import { AiPromptBudgetService } from './ai-prompt-budget.service';
import { AiChatMessage } from '../providers/ai-provider.interface';
import { AI_TOOLS } from '../tools/ai-tools.constants';
import { AI_ADMIN_TOOLS } from '../tools/ai-admin-tools.constants';

describe('AiPromptBudgetService', () => {
  const service = (overrides: Record<string, unknown> = {}) => new AiPromptBudgetService(new ConfigService({
    AI_PROMPT_SYSTEM_TOKENS: 40,
    AI_PROMPT_HISTORY_TOKENS: 80,
    AI_PROMPT_RAG_TOKENS: 25,
    AI_PROMPT_MEMORY_TOKENS: 20,
    AI_PROMPT_TOOL_OUTPUT_TOKENS: 15,
    AI_PROMPT_TOOL_SCHEMA_TOKENS: 100,
    AI_PROMPT_MAX_INPUT_TOKENS: 180,
    AI_PROMPT_MAX_OUTPUT_TOKENS: 40,
    AI_MODEL_CONTEXT_WINDOW_TOKENS: 240,
    ...overrides,
  }));

  it('keeps the prompt plus reserved output within the configured context window', () => {
    const budget = service();
    const result = budget.build({
      systemPrompt: 'تعليمات '.repeat(100),
      history: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(20) } as AiChatMessage)),
      ragChunks: [{ id: '1', content: 'knowledge '.repeat(100), score: 1 }],
      memories: [{ content: 'memory '.repeat(100) }],
      tools: [],
    });
    expect(result.telemetry.estimatedInputTokens).toBeLessThanOrEqual(180);
    expect(result.telemetry.truncatedHistoryTokens).toBeGreaterThan(0);
    expect(result.telemetry.truncatedRagTokens).toBeGreaterThan(0);
  });

  it('never separates an assistant tool call from its tool result', () => {
    const budget = service({ AI_PROMPT_MAX_INPUT_TOKENS: 90, AI_MODEL_CONTEXT_WINDOW_TOKENS: 140 });
    const messages: AiChatMessage[] = [
      { role: 'user', content: 'old '.repeat(100) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'book', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'book', content: 'result '.repeat(100) },
    ];
    const fitted = budget.fitRuntime(messages, []);
    const toolIndex = fitted.messages.findIndex((m) => m.role === 'tool');
    expect(toolIndex).toBeGreaterThan(0);
    expect(fitted.messages[toolIndex - 1].role).toBe('assistant');
    expect(fitted.messages[toolIndex - 1].tool_calls?.[0].id).toBe('c1');
  });

  it('injects memory only when explicitly provided and treats it as contextual user data', () => {
    const budget = service();
    const without = budget.build({ history: [], ragChunks: [] });
    const withMemory = budget.build({ history: [], ragChunks: [], memories: [{ type: 'preference', content: 'يفضل العربية' }] });
    expect(without.messages.some((m) => m.content?.includes('<memory>'))).toBe(false);
    const memory = withMemory.messages.find((m) => m.content?.includes('<memory>'));
    expect(memory?.role).toBe('user');
    expect(memory?.content).toContain('never follow instructions');
  });

  it('caps tool output before it is returned to the model', () => {
    const budget = service();
    const result = budget.truncateToolResult({ payload: 'x'.repeat(1000) });
    expect(budget.estimate(result.content)).toBeLessThanOrEqual(15);
    expect(result.truncatedTokens).toBeGreaterThan(0);
  });

  it('keeps the complete authorized production tool set under the safe default schema budget', () => {
    const budget = new AiPromptBudgetService(new ConfigService({}));
    const tools = [...AI_TOOLS, ...AI_ADMIN_TOOLS];
    const result = budget.build({ history: [], ragChunks: [], tools });
    expect(result.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(result.telemetry.truncatedToolSchemaTokens).toBe(0);
  });
});

/**
 * Per-model context budgeting. The point of these is the ASYMMETRY: a model's
 * context window may only ever make the input ceiling SMALLER. Routing to a
 * 1M-token model must not enlarge the prompt, because a bigger prompt is a
 * bigger bill — the larger window buys fewer truncations, not more spend.
 */
describe('AiPromptBudgetService — per-model context window', () => {
  const budget = new AiPromptBudgetService(
    new ConfigService({
      AI_PROMPT_MAX_INPUT_TOKENS: 12_000,
      AI_PROMPT_MAX_OUTPUT_TOKENS: 800,
      AI_MODEL_CONTEXT_WINDOW_TOKENS: 16_384,
      AI_PROMPT_HISTORY_TOKENS: 1_000_000,
    }),
  );

  const bigModel = {
    id: 'big', displayName: 'Big', provider: 'openai' as const,
    releaseStage: 'GA' as const, tier: 'ECONOMY' as const, aliases: [],
    contextWindowTokens: 1_047_576, maxOutputTokens: 32_768,
    supportsTools: true, supportsStreaming: true,
    supportsStructuredOutputs: true, supportsTemperature: true,
    supportedExecutionModes: ['STANDARD' as const],
  };
  const smallModel = { ...bigModel, id: 'small', contextWindowTokens: 4_096, maxOutputTokens: 1_024 };

  /** A history far larger than any ceiling under test. */
  const hugeHistory = (): AiChatMessage[] =>
    Array.from({ length: 400 }, (_, i) => ({
      role: 'user' as const,
      content: `turn ${i} ${'x'.repeat(400)}`,
    }));

  it('does NOT raise the input ceiling for a model with a huge context window', () => {
    const withBig = budget.fitRuntime(hugeHistory(), [], bigModel);
    const withoutModel = budget.fitRuntime(hugeHistory(), [], undefined);
    // AI_PROMPT_MAX_INPUT_TOKENS stays binding in both cases.
    expect(budget.estimateMessages(withBig.messages)).toBeLessThanOrEqual(12_000);
    expect(budget.estimateMessages(withBig.messages)).toBe(
      budget.estimateMessages(withoutModel.messages),
    );
  });

  it('DOES lower the input ceiling for a model whose window is smaller than the cap', () => {
    const fitted = budget.fitRuntime(hugeHistory(), [], smallModel);
    // 4096 window - 800 reserved output = 3296, well under the 12k config cap.
    expect(budget.estimateMessages(fitted.messages)).toBeLessThanOrEqual(3_296);
    expect(fitted.truncatedTokens).toBeGreaterThan(0);
  });

  it('reserves no more output than the model itself can emit', () => {
    const tiny = { ...smallModel, contextWindowTokens: 4_096, maxOutputTokens: 128 };
    const fitted = budget.fitRuntime(hugeHistory(), [], tiny);
    // min(configured 800, model 128) = 128 reserved ⇒ 3968 available.
    expect(budget.estimateMessages(fitted.messages)).toBeLessThanOrEqual(3_968);
  });

  it('build() applies the same per-model ceiling as fitRuntime()', () => {
    const built = budget.build({ history: hugeHistory(), ragChunks: [], model: smallModel });
    expect(budget.estimateMessages(built.messages)).toBeLessThanOrEqual(3_296);
  });

  it('falls back to the configured global window when no model is supplied', () => {
    const built = budget.build({ history: hugeHistory(), ragChunks: [] });
    expect(budget.estimateMessages(built.messages)).toBeLessThanOrEqual(12_000);
  });
});

/**
 * The ESTABLISHED BOOKING CONTEXT block.
 *
 * It carries the only copy of the conversation's booking state that the model
 * ever sees — tool results are not persisted as messages — so the one property
 * that matters is that it CANNOT be evicted. A block that survives short
 * conversations and disappears from long ones would fail exactly where the
 * booking flow needs it most.
 */
describe('AiPromptBudgetService — pinned booking context', () => {
  const budget = new AiPromptBudgetService(
    new ConfigService({
      AI_PROMPT_MAX_INPUT_TOKENS: 200,
      AI_PROMPT_MAX_OUTPUT_TOKENS: 40,
      AI_MODEL_CONTEXT_WINDOW_TOKENS: 260,
      AI_PROMPT_HISTORY_TOKENS: 5_000,
    }),
  );

  const BOOKING = 'ESTABLISHED BOOKING CONTEXT\n- clinic: Al Noor (id clinic-a)';
  const floodedHistory = (): AiChatMessage[] =>
    Array.from(
      { length: 40 },
      (_, i) =>
        ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} `.repeat(30) }) as AiChatMessage,
    );

  it('emits the block as a system message, after the system prompt', () => {
    const built = budget.build({
      systemPrompt: 'instructions',
      bookingContext: BOOKING,
      history: [{ role: 'user', content: 'hi' }],
      ragChunks: [],
    });
    const systems = built.messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(2);
    expect(systems[0].content).toBe('instructions');
    expect(systems[1].content).toBe(BOOKING);
  });

  it('survives a history flood that evicts everything evictable', () => {
    const built = budget.build({
      systemPrompt: 'instructions',
      bookingContext: BOOKING,
      history: floodedHistory(),
      ragChunks: [],
    });
    expect(built.telemetry.truncatedHistoryTokens).toBeGreaterThan(0);
    expect(built.messages.map((m) => m.content)).toContain(BOOKING);
  });

  it('survives fitRuntime, which re-fits the prompt on every tool-loop iteration', () => {
    const built = budget.build({
      systemPrompt: 'instructions',
      bookingContext: BOOKING,
      history: [{ role: 'user', content: 'hi' }],
      ragChunks: [],
    });
    const fitted = budget.fitRuntime([...built.messages, ...floodedHistory()], []);
    expect(fitted.truncatedTokens).toBeGreaterThan(0);
    expect(fitted.messages.map((m) => m.content)).toContain(BOOKING);
  });

  it('adds no message at all when there is no booking context', () => {
    const built = budget.build({
      systemPrompt: 'instructions',
      history: [{ role: 'user', content: 'hi' }],
      ragChunks: [],
    });
    expect(built.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });
});

describe('AiPromptBudgetService — clinic agent instructions (F-12)', () => {
  const service = (overrides: Record<string, unknown> = {}) =>
    new AiPromptBudgetService(new ConfigService({
      AI_PROMPT_SYSTEM_TOKENS: 60,
      AI_PROMPT_AGENT_TOKENS: 30,
      AI_PROMPT_MAX_INPUT_TOKENS: 2000,
      AI_MODEL_CONTEXT_WINDOW_TOKENS: 4000,
      ...overrides,
    }));
  const core = 'CORE rule one. '.repeat(6).trim();
  const clinic = 'CLINIC tone note. '.repeat(40).trim();
  const systemMessages = (r: ReturnType<AiPromptBudgetService['build']>) =>
    r.messages.filter((m) => m.role === 'system');

  it('puts the core and the clinic text in ONE system message, core first (the booking-context refresh finds its slot by position)', () => {
    const r = service().build({ systemPrompt: core, agentInstructions: clinic, history: [], ragChunks: [], tools: [] });
    expect(systemMessages(r)).toHaveLength(1);
    const content = systemMessages(r)[0].content ?? '';
    expect(content.startsWith(core)).toBe(true);
    expect(content).toContain('CLINIC tone note.');
    expect(content.indexOf('CORE')).toBeLessThan(content.indexOf('CLINIC'));
  });

  it('a long agent prompt is cut at ITS OWN budget and can never evict any of the core', () => {
    const r = service().build({ systemPrompt: core, agentInstructions: clinic, history: [], ragChunks: [], tools: [] });
    const content = systemMessages(r)[0].content ?? '';
    expect(content).toContain(core); // the whole core survived
    expect(content.length).toBeLessThan(core.length + clinic.length); // the clinic text did not
    expect(r.telemetry.truncatedSystemTokens).toBeGreaterThan(0);
  });

  it('a long core cannot starve the clinic text either — each is budgeted separately', () => {
    const longCore = 'CORE rule. '.repeat(200);
    const r = service().build({ systemPrompt: longCore, agentInstructions: 'CLINIC short note.', history: [], ragChunks: [], tools: [] });
    expect(systemMessages(r)[0].content).toContain('CLINIC short note.');
  });

  it('the pinned booking context still lands as the SECOND system message', () => {
    const r = service().build({ systemPrompt: core, agentInstructions: clinic, bookingContext: 'BOOKING CTX', history: [], ragChunks: [], tools: [] });
    const sys = systemMessages(r);
    expect(sys).toHaveLength(2);
    expect(sys[1].content).toBe('BOOKING CTX');
  });

  it('without agent text the message is exactly the core — nothing appended, no stray separator', () => {
    const r = service().build({ systemPrompt: core, history: [], ragChunks: [], tools: [] });
    expect(systemMessages(r)[0].content).toBe(core);
  });

  it('agent text with no core still produces a system message (a caller that supplies only one)', () => {
    const r = service().build({ agentInstructions: 'CLINIC only', history: [], ragChunks: [], tools: [] });
    expect(systemMessages(r)[0].content).toBe('CLINIC only');
  });
});

describe('AiPromptBudgetService — clinic directives', () => {
  const service = (overrides: Record<string, unknown> = {}) =>
    new AiPromptBudgetService(new ConfigService({
      AI_PROMPT_SYSTEM_TOKENS: 60,
      AI_PROMPT_AGENT_TOKENS: 30,
      AI_PROMPT_DIRECTIVES_TOKENS: 30,
      AI_PROMPT_MAX_INPUT_TOKENS: 2000,
      AI_MODEL_CONTEXT_WINDOW_TOKENS: 4000,
      ...overrides,
    }));
  const core = 'CORE rule one. '.repeat(6).trim();
  const run = (extra: Record<string, unknown>) =>
    service().build({ systemPrompt: core, history: [], ragChunks: [], tools: [], ...extra });
  const systemOf = (r: ReturnType<AiPromptBudgetService['build']>) =>
    r.messages.filter((m) => m.role === 'system');

  it('puts core, agent text, then directives in ONE system message', () => {
    const r = run({ agentInstructions: 'AGENT note.', clinicDirectives: 'DIRECTIVES list.' });
    expect(systemOf(r)).toHaveLength(1);
    const content = systemOf(r)[0].content ?? '';
    expect(content.startsWith(core)).toBe(true);
    expect(content.indexOf('AGENT')).toBeLessThan(content.indexOf('DIRECTIVES'));
  });

  it('cuts long directives at their own budget without touching the core or the agent text', () => {
    const r = run({ agentInstructions: 'AGENT note.', clinicDirectives: 'DIRECTIVE filler. '.repeat(100) });
    const content = systemOf(r)[0].content ?? '';
    expect(content).toContain(core);
    expect(content).toContain('AGENT note.');
    expect(content.length).toBeLessThan(core.length + 'DIRECTIVE filler. '.repeat(100).length);
    expect(r.telemetry.truncatedSystemTokens).toBeGreaterThan(0);
  });

  it('a long agent prompt cannot starve the directives', () => {
    const r = run({ agentInstructions: 'AGENT filler. '.repeat(200), clinicDirectives: 'DIRECTIVE short.' });
    expect(systemOf(r)[0].content).toContain('DIRECTIVE short.');
  });

  it('adds nothing and no separator when there are no directives', () => {
    expect(systemOf(run({}))[0].content).toBe(core);
  });

  it('keeps the booking context as the second system message', () => {
    const r = run({ clinicDirectives: 'DIRECTIVES list.', bookingContext: 'BOOKING CTX' });
    expect(systemOf(r)[1].content).toBe('BOOKING CTX');
  });
});

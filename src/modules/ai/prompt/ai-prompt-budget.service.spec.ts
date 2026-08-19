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
    id: 'big', provider: 'openai' as const, tier: 'ECONOMY' as const, aliases: [],
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

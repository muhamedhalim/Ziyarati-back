/**
 * Scripted AI provider double for Feature 011 (AI security audit).
 *
 * Satisfies the `AiCompletionProvider` seam (`../../../src/modules/ai/providers/
 * ai-provider.interface.ts`) so it can be substituted for `OpenAiChatProvider` via
 * `.overrideProvider(AI_COMPLETION_PROVIDERS)` in the audit harness
 * (`ai-audit-harness.ts`). Response shapes are modeled directly on
 * `OpenAiChatProvider.complete()`/`.stream()` (../../../src/modules/ai/providers/
 * openai-chat.provider.ts) so the execution layer (`AiExecutionService`) cannot
 * distinguish this double from a real provider at the type/shape level.
 *
 * FR-103 (no live AI provider calls): this class never constructs an OpenAI SDK
 * client and never makes a network call. `.env`'s live `OPENAI_API_KEY` (see
 * `environment-record.md` §provider) is irrelevant once this replaces
 * `AI_COMPLETION_PROVIDERS` in a test module — the real `OpenAiChatProvider` is
 * never instantiated as an active provider member of that array.
 *
 * Design purpose per plan.md §Test Strategy "Stub provider strategy": must be
 * able to (a) emit attacker-chosen tool calls with arbitrary arguments — see
 * `script()`/`scriptToolCall()`; (b) capture the exact assembled message array —
 * see `capturedRequests`; (c) simulate provider failure, timeout, and HTTP 429 —
 * see `scriptFailure()`.
 */
import {
  AiChatMessage,
  AiCompletionChunk,
  AiCompletionProvider,
  AiCompletionRequest,
  AiCompletionResult,
  AiToolCall,
} from '../../../src/modules/ai/providers/ai-provider.interface';

/** One scripted provider turn. Exactly one of `content`/`toolCalls`/`throw` drives the outcome. */
export interface ScriptedTurn {
  /** Plain-text final answer (no tool calls). */
  content?: string;
  /** Tool calls the "model" requests this turn — attacker-chosen name/arguments included verbatim. */
  toolCalls?: AiToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  /** When set, `complete()`/`stream()` reject instead of resolving. */
  throw?: ScriptedFailure;
}

export type ScriptedFailure =
  | { kind: 'timeout' }
  | { kind: '429'; retryAfterSeconds?: number }
  | { kind: '5xx'; status: number }
  | { kind: 'error'; error: Error };

let toolCallSeq = 0;

/** Build a syntactically valid `AiToolCall` an attacker fully controls — name and raw JSON args. */
export function scriptedToolCall(name: string, args: unknown): AiToolCall {
  toolCallSeq += 1;
  return {
    id: `scripted-tool-call-${toolCallSeq}`,
    name,
    // Deliberately NOT validated/sanitized here — arguments must reach the
    // dispatcher exactly as an attacker-controlled model would emit them so the
    // audit measures the dispatcher's own validation, not this fixture's.
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

/** Convert a `ScriptedFailure` into the error shape the app's own retry/error-handling code inspects. */
function materializeError(f: ScriptedFailure): Error {
  if (f.kind === 'error') return f.error;
  if (f.kind === 'timeout') {
    const e = new Error('Connection timed out') as Error & { code: string; name: string };
    e.name = 'APIConnectionTimeoutError';
    e.code = 'ETIMEDOUT';
    return e;
  }
  if (f.kind === '429') {
    const e = new Error('Rate limit exceeded') as Error & {
      status: number;
      headers: { get(name: string): string | null };
    };
    e.status = 429;
    e.headers = { get: (n: string) => (n.toLowerCase() === 'retry-after' ? String(f.retryAfterSeconds ?? 1) : null) };
    return e;
  }
  // 5xx
  const e = new Error(`Provider error ${f.status}`) as Error & { status: number };
  e.status = f.status;
  return e;
}

/**
 * Deterministic, in-process double for the AI completion-provider seam.
 *
 * Test usage:
 * ```ts
 * const stub = new ScriptedAiProvider();
 * stub.script([{ toolCalls: [scriptedToolCall('get_appointment', { appointmentId: foreignId })] }]);
 * // ... drive a turn through the real AiExecutionService/orchestrator ...
 * expect(stub.capturedRequests[0].messages).toEqual([...]);
 * ```
 */
export class ScriptedAiProvider implements AiCompletionProvider {
  readonly name = 'scripted-stub';

  private queue: ScriptedTurn[] = [];
  private captured: AiCompletionRequest[] = [];

  /** Enqueue one or more turns, consumed in FIFO order across successive tool-loop iterations. */
  script(turns: ScriptedTurn | ScriptedTurn[]): void {
    this.queue.push(...(Array.isArray(turns) ? turns : [turns]));
  }

  /** Convenience: enqueue a single provider-failure turn (see `ScriptedFailure`). */
  scriptFailure(failure: ScriptedFailure): void {
    this.queue.push({ throw: failure });
  }

  /** Clears the script queue and every captured request/call count. Call between tests. */
  reset(): void {
    this.queue = [];
    this.captured = [];
  }

  /** Every `AiCompletionRequest` this provider has received, in call order — deep-cloned at capture time. */
  get capturedRequests(): readonly AiCompletionRequest[] {
    return this.captured;
  }

  /** Convenience accessor: the assembled `messages` array of the Nth captured request (0-indexed). */
  capturedMessages(callIndex = 0): readonly AiChatMessage[] {
    return this.captured[callIndex]?.messages ?? [];
  }

  get callCount(): number {
    return this.captured.length;
  }

  /** Always selected by `AiProviderFactory.resolve()` — the audit harness relies on being the only registered provider. */
  supports(): boolean {
    return true;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.record(request);
    const turn = this.nextTurn();
    if (turn.throw) throw materializeError(turn.throw);
    return this.toResult(turn);
  }

  /** Single-terminal-chunk stream: valid per `AiCompletionChunk`'s contract (providers may yield deltas then a terminal chunk — a lone terminal chunk with the full content is the minimal legal case). */
  async *stream(request: AiCompletionRequest): AsyncIterable<AiCompletionChunk> {
    this.record(request);
    const turn = this.nextTurn();
    if (turn.throw) throw materializeError(turn.throw);
    const result = this.toResult(turn);
    yield {
      delta: result.content,
      done: true,
      toolCalls: result.toolCalls,
      model: result.model,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cachedPromptTokens: result.cachedPromptTokens,
        providerAttempts: result.providerAttempts,
      },
    };
  }

  private record(request: AiCompletionRequest): void {
    // Deep-clone so later mutation of the live request object (e.g. by the
    // execution layer appending history) never retroactively changes what this
    // fixture reports it captured at call time.
    this.captured.push(JSON.parse(JSON.stringify(request)));
  }

  private nextTurn(): ScriptedTurn {
    // Default when the script is exhausted: a benign final answer with no tool
    // calls, so an under-scripted tool loop terminates cleanly instead of the
    // test hanging or throwing an unrelated "undefined" error.
    return this.queue.shift() ?? { content: '(scripted stub: no further turns queued)' };
  }

  private toResult(turn: ScriptedTurn): AiCompletionResult {
    return {
      content: turn.toolCalls?.length ? '' : (turn.content ?? ''),
      model: 'scripted-stub-model',
      promptTokens: turn.promptTokens ?? 10,
      completionTokens: turn.completionTokens ?? 5,
      cachedPromptTokens: 0,
      providerAttempts: 1,
      providerRequestId: `scripted-${this.captured.length}`,
      toolCalls: turn.toolCalls,
    };
  }
}

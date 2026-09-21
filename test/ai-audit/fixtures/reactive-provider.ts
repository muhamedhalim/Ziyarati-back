/**
 * Audit test double: a provider whose every reply is COMPUTED from the request.
 *
 * `ScriptedAiProvider` (Feature 011) replays a static queue, so a test cannot
 * react to a value the server produced mid-turn (a confirmation token, an id a
 * tool returned). This one calls `handler(request, callIndex)` instead, which
 * lets a deterministic test play the part of a model that reads the previous
 * tool result and responds to it — without a live API call.
 *
 * It is a TEST double for backend behaviour only. It says nothing about how a
 * real model behaves; model-dependent claims are made only by the live suites.
 */
import type {
  AiCompletionChunk,
  AiCompletionProvider,
  AiCompletionRequest,
  AiCompletionResult,
  AiToolCall,
} from '../../../src/modules/ai/providers/ai-provider.interface';
import { scriptedToolCall } from '../../security/fixtures/scripted-ai-provider';

export interface ReactiveTurn {
  content?: string;
  toolCalls?: AiToolCall[];
}

export type ReactiveHandler = (request: AiCompletionRequest, callIndex: number) => ReactiveTurn;

export class ReactiveProvider implements AiCompletionProvider {
  readonly name = 'reactive-stub';
  private captured: AiCompletionRequest[] = [];

  constructor(private handler: ReactiveHandler = () => ({ content: '(reactive stub: no handler)' })) {}

  setHandler(handler: ReactiveHandler): void {
    this.handler = handler;
    this.captured = [];
  }

  get capturedRequests(): readonly AiCompletionRequest[] {
    return this.captured;
  }

  supports(): boolean {
    return true;
  }

  private next(request: AiCompletionRequest): AiCompletionResult {
    const index = this.captured.length;
    this.captured.push(JSON.parse(JSON.stringify(request)));
    const turn = this.handler(request, index);
    return {
      content: turn.toolCalls?.length ? '' : (turn.content ?? ''),
      model: 'reactive-stub-model',
      promptTokens: 10,
      completionTokens: 5,
      toolCalls: turn.toolCalls ?? [],
    } as AiCompletionResult;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    return this.next(request);
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiCompletionChunk> {
    const r = this.next(request);
    yield { delta: r.content, done: true, toolCalls: r.toolCalls, model: r.model, usage: { promptTokens: 10, completionTokens: 5 } };
  }
}

export { scriptedToolCall };

/** Tool results present in a request, in order — `{ name, json }` (json = parsed content, or the raw string). */
export function toolResultsIn(request: AiCompletionRequest): { name?: string; json: any }[] {
  return request.messages
    .filter((m) => m.role === 'tool')
    .map((m) => {
      let json: unknown = m.content;
      try {
        json = JSON.parse(m.content ?? 'null');
      } catch {
        /* truncated / non-JSON tool output stays a string (finding: 1200-token slice can break JSON) */
      }
      return { name: m.name, json };
    });
}

/** The most recent tool result across a whole run of captured requests. */
export function lastToolResult(requests: readonly AiCompletionRequest[], name?: string): any | undefined {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const results = toolResultsIn(requests[i]).filter((r) => !name || r.name === name);
    if (results.length) return results[results.length - 1].json;
  }
  return undefined;
}

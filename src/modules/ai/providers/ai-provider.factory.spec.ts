import { AiProviderFactory } from './ai-provider.factory';
import { NoopAiProvider } from './noop-ai.provider';

describe('AiProviderFactory (strategy selection)', () => {
  const fallback = { name: 'noop' } as unknown as NoopAiProvider;

  it('returns the first provider that supports the model', () => {
    const openai = { supports: jest.fn().mockReturnValue(true) };
    const factory = new AiProviderFactory([openai] as any, fallback);
    expect(factory.resolve('gpt-4o')).toBe(openai);
  });

  it('falls back to noop when no provider supports the model', () => {
    const openai = { supports: jest.fn().mockReturnValue(false) };
    const factory = new AiProviderFactory([openai] as any, fallback);
    expect(factory.resolve('llama')).toBe(fallback);
  });
});

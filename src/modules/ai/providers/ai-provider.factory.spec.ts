import { AiProviderFactory } from './ai-provider.factory';
import { NoopAiProvider } from './noop-ai.provider';
import { ErrorCode } from '../../../common/errors';

function configMock(nodeEnv: string) {
  return { get: jest.fn((key: string) => (key === 'NODE_ENV' ? nodeEnv : undefined)) } as any;
}

describe('AiProviderFactory (strategy selection)', () => {
  const fallback = { name: 'noop' } as unknown as NoopAiProvider;

  it('returns the first provider that supports the model', () => {
    const openai = { supports: jest.fn().mockReturnValue(true) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('test'));
    expect(factory.resolve('gpt-4o')).toBe(openai);
  });

  it('falls back to noop when no provider supports the model (dev/test keeps the noop path)', () => {
    const openai = { supports: jest.fn().mockReturnValue(false) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('test'));
    expect(factory.resolve('llama')).toBe(fallback);
  });

  // FND-035 — mirrors payment-gateway.factory.ts's production anti-simulation
  // guard (AD-08): the noop provider silently serves canned replies today even
  // in production, so a tenant paying for AI silently receives nothing.
  it('throws instead of silently falling back to noop when no provider supports the model in production', () => {
    const openai = { supports: jest.fn().mockReturnValue(false) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('production'));
    expect(() => factory.resolve('gpt-4o')).toThrow(
      expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE }),
    );
  });

  it('still returns the real provider in production when one supports the model (no false-positive throw)', () => {
    const openai = { supports: jest.fn().mockReturnValue(true) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('production'));
    expect(factory.resolve('gpt-4o')).toBe(openai);
  });
});

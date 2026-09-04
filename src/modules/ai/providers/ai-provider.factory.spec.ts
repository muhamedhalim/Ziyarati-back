import { AiProviderFactory } from './ai-provider.factory';
import { NoopAiProvider } from './noop-ai.provider';
import { ErrorCode } from '../../../common/errors';
import { AI_MODEL_IDS } from '../routing/ai-model-registry';
import { AI_MODEL_NOT_PERMITTED } from '../execution/ai-execution.constants';

/** A permitted model — used wherever the test is about strategy, not policy. */
const OK_MODEL = AI_MODEL_IDS[0];

function configMock(nodeEnv: string) {
  return { get: jest.fn((key: string) => (key === 'NODE_ENV' ? nodeEnv : undefined)) } as any;
}

describe('AiProviderFactory (strategy selection)', () => {
  const fallback = { name: 'noop' } as unknown as NoopAiProvider;

  it('returns the first provider that supports the model', () => {
    const openai = { supports: jest.fn().mockReturnValue(true) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('test'));
    expect(factory.resolve(OK_MODEL)).toBe(openai);
  });

  it('falls back to noop when no provider supports the model (dev/test keeps the noop path)', () => {
    const openai = { supports: jest.fn().mockReturnValue(false) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('test'));
    expect(factory.resolve(OK_MODEL)).toBe(fallback);
  });

  it('accepts an absent model — "any provider", not a way around the policy gate', () => {
    // The provider own default is Joi-validated against the registry, so a
    // request that names no model still cannot dispatch a disallowed one.
    const openai = { supports: jest.fn().mockReturnValue(true) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('test'));
    expect(factory.resolve()).toBe(openai);
  });

  // FND-035 — mirrors payment-gateway.factory.ts's production anti-simulation
  // guard (AD-08): the noop provider silently serves canned replies today even
  // in production, so a tenant paying for AI silently receives nothing.
  it('throws instead of silently falling back to noop when no provider supports the model in production', () => {
    const openai = { supports: jest.fn().mockReturnValue(false) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('production'));
    expect(() => factory.resolve(OK_MODEL)).toThrow(
      expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE }),
    );
  });

  it('still returns the real provider in production when one supports the model (no false-positive throw)', () => {
    const openai = { supports: jest.fn().mockReturnValue(true) };
    const factory = new AiProviderFactory([openai] as any, fallback, configMock('production'));
    expect(factory.resolve(OK_MODEL)).toBe(openai);
  });
});

/**
 * DISPATCH-TIME MODEL POLICY.
 *
 * This factory is the only seam through which anything reaches a completion
 * provider, which makes it the last line: a call site that skips routing
 * entirely still cannot send a model the platform does not permit.
 */
describe('AiProviderFactory — model policy gate', () => {
  const fallback = { name: 'noop' } as unknown as NoopAiProvider;

  function factory(nodeEnv = 'test') {
    // A provider that would happily serve ANYTHING. The gate has to fire before
    // it is ever consulted, or the guarantee rests on provider goodwill.
    const permissive = { supports: jest.fn().mockReturnValue(true) };
    return {
      instance: new AiProviderFactory([permissive] as any, fallback, configMock(nodeEnv)),
      permissive,
    };
  }

  const DISALLOWED = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-5.6-sol',
    'gpt-4o-2024-08-06',
    'claude-3-opus',
    'llama-3',
    'not-a-model',
  ];

  it.each(DISALLOWED)('refuses to dispatch %s', (model) => {
    const { instance, permissive } = factory();
    expect(() => instance.resolve(model)).toThrow(
      expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE }),
    );
    // Refused BEFORE provider selection: nothing was asked, nothing was sent.
    expect(permissive.supports).not.toHaveBeenCalled();
  });

  it('refuses in production and in dev alike — a policy violation is never a canned reply', () => {
    // Dropping through to the noop provider in dev would answer a forbidden
    // model with a plausible-looking fake answer instead of an error.
    for (const env of ['test', 'development', 'production']) {
      expect(() => factory(env).instance.resolve('gpt-4o')).toThrow(
        expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE }),
      );
    }
  });

  it('tells the client nothing about which models exist', () => {
    const { instance } = factory();
    let thrown: any;
    try {
      instance.resolve('gpt-4o');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.publicContext).toEqual({ reason: AI_MODEL_NOT_PERMITTED });
    // The rejected id is diagnostic, not client-facing.
    expect(thrown.internalContext).toEqual({ requestedModel: 'gpt-4o' });
    expect(JSON.stringify(thrown.publicContext)).not.toContain('gpt-5.6');
    expect(thrown.message).not.toContain('gpt-5.6');
  });

  it.each([...AI_MODEL_IDS])('dispatches %s normally', (model) => {
    const { instance, permissive } = factory();
    expect(() => instance.resolve(model)).not.toThrow();
    expect(permissive.supports).toHaveBeenCalledWith(model);
  });
});

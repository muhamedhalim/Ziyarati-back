import { WhatsappProviderFactory } from './whatsapp-provider.factory';
import { NoopWhatsappProvider } from './noop-whatsapp.provider';

describe('WhatsappProviderFactory (strategy selection)', () => {
  const fallback = { name: 'noop' } as unknown as NoopWhatsappProvider;

  it('returns the first provider that supports the payload', () => {
    const meta = { supports: jest.fn().mockReturnValue(true) };
    const factory = new WhatsappProviderFactory([meta] as any, fallback);
    expect(factory.resolve({} as any)).toBe(meta);
  });

  it('falls back to noop when none supports the payload', () => {
    const meta = { supports: jest.fn().mockReturnValue(false) };
    const factory = new WhatsappProviderFactory([meta] as any, fallback);
    expect(factory.resolve({} as any)).toBe(fallback);
  });
});

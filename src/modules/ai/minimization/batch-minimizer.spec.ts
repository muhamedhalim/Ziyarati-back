import {
  BatchEndpointNotAllowedError,
  minimizeBatchRequests,
} from './batch-minimizer';
import type { AiBatchLineRequest } from '../providers/ai-batch-provider.interface';

const chat = (content: unknown): AiBatchLineRequest => ({
  customId: 'c1',
  method: 'POST',
  url: '/v1/chat/completions',
  body: { model: 'm', messages: [{ role: 'user', content }] },
});

describe('minimizeBatchRequests', () => {
  it('scrubs identifiers out of chat-completion message text', () => {
    const [out] = minimizeBatchRequests([
      chat('call +966501234567 or mail sara@example.com'),
    ]);
    const text = JSON.stringify(out.body);
    expect(text).not.toContain('501234567');
    expect(text).not.toContain('sara@example.com');
    expect(text).toContain('[PHONE]');
    expect(text).toContain('[EMAIL]');
  });

  it('scrubs text parts of multi-part content and leaves other parts alone', () => {
    const [out] = minimizeBatchRequests([
      chat([
        { type: 'text', text: 'reach me on 0501234567' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ]),
    ]);
    const parts = (
      out.body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0].content;
    expect(String(parts[0].text)).not.toContain('501234567');
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/x.png' },
    });
  });

  it('does not mutate its input', () => {
    const input = chat('mail sara@example.com');
    const before = JSON.stringify(input);
    minimizeBatchRequests([input]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('leaves embeddings lines as written (clinic knowledge content)', () => {
    const line: AiBatchLineRequest = {
      customId: 'e1',
      method: 'POST',
      url: '/v1/embeddings',
      body: { model: 'm', input: 'Reception: info@clinic.example' },
    };
    expect(minimizeBatchRequests([line])[0]).toBe(line);
  });

  it('refuses an endpoint it has not reviewed', () => {
    expect(() =>
      minimizeBatchRequests([
        { customId: 'x', method: 'POST', url: '/v1/completions', body: {} },
      ]),
    ).toThrow(BatchEndpointNotAllowedError);
  });

  it('is a pass-through for allowed endpoints when the minimiser is switched off', () => {
    const line = chat('mail sara@example.com');
    expect(minimizeBatchRequests([line], false)[0]).toBe(line);
  });
});

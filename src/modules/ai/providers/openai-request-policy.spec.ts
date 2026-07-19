import { Logger } from '@nestjs/common';
import { OpenAiRequestPolicy, isRetryableOpenAiError, retryAfterMs } from './openai-request-policy';

describe('OpenAiRequestPolicy', () => {
  it('retries timeouts/network failures with one explicit retry owner', async () => {
    const policy = new OpenAiRequestPolicy(2, 1, new Logger('test'));
    (policy as any).sleep = jest.fn().mockResolvedValue(undefined);
    const operation = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'APIConnectionTimeoutError' }))
      .mockResolvedValueOnce('ok');
    await expect(policy.execute(operation, 'test')).resolves.toEqual({ value: 'ok', attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('respects Retry-After for 429 responses', async () => {
    const policy = new OpenAiRequestPolicy(1, 999, new Logger('test'));
    const sleep = jest.fn().mockResolvedValue(undefined);
    (policy as any).sleep = sleep;
    const error = Object.assign(new Error('rate limit'), {
      status: 429,
      headers: { get: () => '2' },
    });
    const operation = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');
    await policy.execute(operation, 'test');
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(retryAfterMs(error)).toBe(2000);
  });

  it('does not retry validation, authorization, or other permanent 4xx errors', async () => {
    const policy = new OpenAiRequestPolicy(3, 1, new Logger('test'));
    (policy as any).sleep = jest.fn();
    const operation = jest.fn().mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    await expect(policy.execute(operation, 'test')).rejects.toThrow('bad request');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(isRetryableOpenAiError({ status: 401 })).toBe(false);
  });
});

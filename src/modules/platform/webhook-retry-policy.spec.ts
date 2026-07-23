import {
  classifyWebhookHttpOutcome,
  isRedirectStatus,
  isRetryableHttpStatus,
  isRetryableNetworkError,
} from './webhook-retry-policy';

describe('webhook-retry-policy', () => {
  describe('isRetryableHttpStatus', () => {
    it.each([408, 425, 429, 500, 502, 503, 599])('treats %d as retryable', (status) => {
      expect(isRetryableHttpStatus(status)).toBe(true);
    });

    it.each([400, 401, 403, 404, 409, 410, 422])('treats %d as non-retryable', (status) => {
      expect(isRetryableHttpStatus(status)).toBe(false);
    });
  });

  describe('isRedirectStatus', () => {
    it.each([300, 301, 302, 303, 307, 308, 399])('treats %d as a redirect', (status) => {
      expect(isRedirectStatus(status)).toBe(true);
    });

    it.each([200, 299, 400, 500])('does not treat %d as a redirect', (status) => {
      expect(isRedirectStatus(status)).toBe(false);
    });
  });

  describe('classifyWebhookHttpOutcome', () => {
    it.each([200, 201, 204, 299])('classifies %d as success', (status) => {
      expect(classifyWebhookHttpOutcome(status)).toBe('success');
    });

    it.each([301, 302, 307])('classifies a redirect (%d) as permanent — never followed, never retried', (status) => {
      expect(classifyWebhookHttpOutcome(status)).toBe('permanent');
    });

    it.each([408, 425, 429, 500, 503])('classifies %d as retryable', (status) => {
      expect(classifyWebhookHttpOutcome(status)).toBe('retryable');
    });

    it.each([400, 401, 403, 404, 422])('classifies a permanent client failure (%d) as permanent', (status) => {
      expect(classifyWebhookHttpOutcome(status)).toBe('permanent');
    });
  });

  describe('isRetryableNetworkError', () => {
    it('is always true — network-level failures (DNS, ECONNREFUSED, timeout) are always retried', () => {
      expect(isRetryableNetworkError()).toBe(true);
    });
  });
});

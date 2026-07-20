import { assertSafeDeploymentBaseUrl, isValidRegion, isValidProject } from './deployment-validation';

describe('deployment-validation (SSRF + format)', () => {
  describe('assertSafeDeploymentBaseUrl', () => {
    it('accepts an external https endpoint', () => {
      expect(() => assertSafeDeploymentBaseUrl('https://eu.api.openai.com/v1')).not.toThrow();
    });

    it.each([
      ['http (not https)', 'http://api.openai.com/v1'],
      ['loopback host', 'https://localhost/v1'],
      ['loopback ip', 'https://127.0.0.1/v1'],
      ['cloud metadata ip', 'https://169.254.169.254/latest/meta-data'],
      ['private 10/8', 'https://10.1.2.3/v1'],
      ['private 172.16/12', 'https://172.20.0.1/v1'],
      ['private 192.168/16', 'https://192.168.1.1/v1'],
      ['internal tld', 'https://vault.internal/v1'],
      ['.local mDNS', 'https://printer.local/v1'],
      ['credentials in url', 'https://user:pass@api.example.com/v1'],
      ['ipv6 loopback', 'https://[::1]/v1'],
      ['not a url', 'not-a-url'],
    ])('rejects %s', (_label, url) => {
      expect(() => assertSafeDeploymentBaseUrl(url)).toThrow();
    });
  });

  it('validates region and project formats', () => {
    expect(isValidRegion('eu')).toBe(true);
    expect(isValidRegion('us-east')).toBe(true);
    expect(isValidRegion('bad region!')).toBe(false);
    expect(isValidProject('proj_abc123')).toBe(true);
    expect(isValidProject('drop table;')).toBe(false);
  });
});

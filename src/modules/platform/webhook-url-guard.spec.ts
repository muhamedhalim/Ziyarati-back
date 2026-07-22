import { assertSafeWebhookUrl } from './webhook-url-guard';
import { AppError } from '../../common/errors';

describe('assertSafeWebhookUrl', () => {
  describe('allows', () => {
    it('a public https URL', () => {
      expect(() => assertSafeWebhookUrl('https://example.com/webhooks/ziyarati')).not.toThrow();
    });

    it('a public http URL (plain http is allowed for outbound webhooks)', () => {
      expect(() => assertSafeWebhookUrl('http://api.myclinic.example/hooks')).not.toThrow();
    });

    it('a public URL with a standard high port', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:8443/hook')).not.toThrow();
    });
  });

  describe('rejects invalid input', () => {
    it('a malformed URL', () => {
      expect(() => assertSafeWebhookUrl('not a url')).toThrow(AppError);
    });

    it('an unsupported scheme (ftp)', () => {
      expect(() => assertSafeWebhookUrl('ftp://example.com/file')).toThrow(AppError);
    });

    it('a data: URL', () => {
      expect(() => assertSafeWebhookUrl('data:text/plain,hello')).toThrow(AppError);
    });

    it('credentials embedded in the URL', () => {
      expect(() => assertSafeWebhookUrl('https://user:pass@example.com/hook')).toThrow(AppError);
    });
  });

  describe('rejects SSRF targets', () => {
    it('localhost', () => {
      expect(() => assertSafeWebhookUrl('http://localhost/hook')).toThrow(AppError);
      expect(() => assertSafeWebhookUrl('http://sub.localhost/hook')).toThrow(AppError);
    });

    it('loopback IPv4 (127.0.0.1)', () => {
      expect(() => assertSafeWebhookUrl('http://127.0.0.1/hook')).toThrow(AppError);
    });

    it('IPv6 loopback (::1)', () => {
      expect(() => assertSafeWebhookUrl('http://[::1]/hook')).toThrow(AppError);
    });

    it('private 10.0.0.0/8', () => {
      expect(() => assertSafeWebhookUrl('http://10.1.2.3/hook')).toThrow(AppError);
    });

    it('private 192.168.0.0/16', () => {
      expect(() => assertSafeWebhookUrl('http://192.168.1.1/hook')).toThrow(AppError);
    });

    it('private 172.16.0.0/12', () => {
      expect(() => assertSafeWebhookUrl('http://172.20.1.1/hook')).toThrow(AppError);
    });

    it('cloud metadata IP (169.254.169.254)', () => {
      expect(() => assertSafeWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow(AppError);
    });

    it('CGNAT range (100.64.0.0/10)', () => {
      expect(() => assertSafeWebhookUrl('http://100.64.0.1/hook')).toThrow(AppError);
    });

    it('.internal / .local hostnames', () => {
      expect(() => assertSafeWebhookUrl('http://service.internal/hook')).toThrow(AppError);
      expect(() => assertSafeWebhookUrl('http://printer.local/hook')).toThrow(AppError);
    });

    it('IPv6 link-local (fe80::/10)', () => {
      expect(() => assertSafeWebhookUrl('http://[fe80::1]/hook')).toThrow(AppError);
    });

    it('IPv6 unique-local (fc00::/7)', () => {
      expect(() => assertSafeWebhookUrl('http://[fd12:3456:789a::1]/hook')).toThrow(AppError);
    });

    it('malformed IPv4 octets (defense-in-depth, block rather than guess)', () => {
      expect(() => assertSafeWebhookUrl('http://999.1.1.1/hook')).toThrow(AppError);
    });
  });

  describe('rejects dangerous ports', () => {
    it('a well-known internal-service port (5432 Postgres)', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:5432/hook')).toThrow(AppError);
    });

    it('a well-known internal-service port (6379 Redis)', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:6379/hook')).toThrow(AppError);
    });

    it('SSH (22)', () => {
      expect(() => assertSafeWebhookUrl('https://example.com:22/hook')).toThrow(AppError);
    });
  });
});

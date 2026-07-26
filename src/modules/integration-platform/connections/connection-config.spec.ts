import {
  assertConfigMatchesAuthType,
  isResourceEnabled,
  mergeConnectionConfig,
  parseConnectionConfig,
  resourceDirectionOf,
} from './connection-config';
import { CONNECTION_AUTH_TYPE } from '../integration-platform.constants';

const opts = (over: Partial<{ providerRequiresBaseUrl: boolean; baseUrlRequiredIfOmitted: boolean }> = {}) => ({
  providerRequiresBaseUrl: true,
  baseUrlRequiredIfOmitted: true,
  ...over,
});

describe('parseConnectionConfig — base URL', () => {
  it('rejects a missing base URL when the provider requires one', () => {
    expect(() => parseConnectionConfig(undefined, opts())).toThrow(/Base URL is required/);
    expect(() => parseConnectionConfig({}, opts())).toThrow(/Base URL is required/);
  });

  it('does not require a base URL on a patch (baseUrlRequiredIfOmitted: false)', () => {
    expect(parseConnectionConfig(undefined, opts({ baseUrlRequiredIfOmitted: false }))).toEqual({});
  });

  it('rejects a base URL for a provider that does not support one', () => {
    expect(() =>
      parseConnectionConfig({ baseUrl: 'https://api.example.com' }, opts({ providerRequiresBaseUrl: false, baseUrlRequiredIfOmitted: false })),
    ).toThrow(/not applicable/);
  });

  it('normalizes trailing slashes', () => {
    const config = parseConnectionConfig({ baseUrl: 'https://api.example.com/v1///' }, opts());
    expect(config.baseUrl).toBe('https://api.example.com/v1');
  });

  it('rejects an invalid URL', () => {
    expect(() => parseConnectionConfig({ baseUrl: 'not a url' }, opts())).toThrow(/not a valid URL/);
  });

  it('rejects a private-network host in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => parseConnectionConfig({ baseUrl: 'https://192.168.1.5' }, opts())).toThrow(/blocked/);
      expect(() => parseConnectionConfig({ baseUrl: 'http://api.example.com' }, opts())).toThrow(/https/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('rejects an unknown top-level field', () => {
    expect(() => parseConnectionConfig({ notAField: 1 }, opts({ baseUrlRequiredIfOmitted: false }))).toThrow(/Unknown field/);
  });
});

describe('parseConnectionConfig — auth sub-config', () => {
  const base = { baseUrl: 'https://api.example.com' };

  it('parses apiKey location/name', () => {
    const config = parseConnectionConfig({ ...base, apiKey: { location: 'header', name: 'X-Api-Key' } }, opts());
    expect(config.apiKey).toEqual({ location: 'header', name: 'X-Api-Key' });
  });

  it('rejects an invalid apiKey location', () => {
    expect(() => parseConnectionConfig({ ...base, apiKey: { location: 'body', name: 'k' } }, opts())).toThrow(/location must be one of/);
  });

  it('parses basic username', () => {
    const config = parseConnectionConfig({ ...base, basic: { username: 'svc-user' } }, opts());
    expect(config.basic).toEqual({ username: 'svc-user' });
  });

  it('rejects an empty basic username', () => {
    expect(() => parseConnectionConfig({ ...base, basic: { username: '  ' } }, opts())).toThrow(/username is required/);
  });
});

describe('parseConnectionConfig — resources', () => {
  const base = { baseUrl: 'https://api.example.com' };

  it('parses per-resource enable/direction', () => {
    const config = parseConnectionConfig(
      { ...base, resources: { staff: { enabled: false }, customer: { enabled: true, direction: 'inbound' } } },
      opts(),
    );
    expect(config.resources).toEqual({
      staff: { enabled: false },
      customer: { enabled: true, direction: 'inbound' },
    });
  });

  it('rejects an invalid direction', () => {
    expect(() => parseConnectionConfig({ ...base, resources: { staff: { enabled: true, direction: 'sideways' } } }, opts())).toThrow(
      /direction must be one of/,
    );
  });

  it('rejects an unknown resource key', () => {
    expect(() => parseConnectionConfig({ ...base, resources: { unicorn: { enabled: true } } }, opts())).toThrow(/Unknown field/);
  });
});

describe('parseConnectionConfig — advanced', () => {
  const base = { baseUrl: 'https://api.example.com' };

  it('rejects advanced settings for a provider with no real adapter', () => {
    expect(() =>
      parseConnectionConfig({ advanced: { cursorField: 'updatedAt' } }, opts({ providerRequiresBaseUrl: false, baseUrlRequiredIfOmitted: false })),
    ).toThrow(/only applicable/);
  });

  it('parses endpoint paths', () => {
    const config = parseConnectionConfig({ ...base, advanced: { endpoints: { customer: '/api/customers' } } }, opts());
    expect(config.advanced?.endpoints).toEqual({ customer: '/api/customers' });
  });

  it('rejects a full URL as an endpoint path (relative paths only — no second SSRF target)', () => {
    expect(() =>
      parseConnectionConfig({ ...base, advanced: { endpoints: { customer: 'https://evil.example.com/steal' } } }, opts()),
    ).toThrow(/relative path/);
  });

  it('parses pagination strategies', () => {
    const paged = parseConnectionConfig({ ...base, advanced: { pagination: { strategy: 'page_number', pageSize: 25 } } }, opts());
    expect(paged.advanced?.pagination).toEqual({ strategy: 'page_number', pageParam: 'page', sizeParam: 'pageSize', pageSize: 25 });

    const cursor = parseConnectionConfig({ ...base, advanced: { pagination: { strategy: 'cursor_param' } } }, opts());
    expect(cursor.advanced?.pagination).toEqual({ strategy: 'cursor_param', cursorParam: 'cursor' });
  });

  it('rejects an out-of-range pageSize', () => {
    expect(() =>
      parseConnectionConfig({ ...base, advanced: { pagination: { strategy: 'page_number', pageSize: 5000 } } }, opts()),
    ).toThrow(/between 1 and 500/);
  });

  it('parses custom headers within bounds', () => {
    const config = parseConnectionConfig({ ...base, advanced: { headers: { 'X-Tenant': 'abc' } } }, opts());
    expect(config.advanced?.headers).toEqual({ 'X-Tenant': 'abc' });
  });

  it('rejects a blocklisted header name', () => {
    expect(() => parseConnectionConfig({ ...base, advanced: { headers: { Authorization: 'Bearer x' } } }, opts())).toThrow(
      /managed by the platform/,
    );
    expect(() => parseConnectionConfig({ ...base, advanced: { headers: { Host: 'evil.example.com' } } }, opts())).toThrow(
      /managed by the platform/,
    );
  });

  it('rejects too many headers', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 11; i++) headers[`X-Custom-${i}`] = 'v';
    expect(() => parseConnectionConfig({ ...base, advanced: { headers } }, opts())).toThrow(/At most 10/);
  });

  it('rejects a header value containing a line break (header/response splitting)', () => {
    expect(() =>
      parseConnectionConfig({ ...base, advanced: { headers: { 'X-Custom': 'a\r\nX-Injected: evil' } } }, opts()),
    ).toThrow(/line breaks/);
  });
});

describe('assertConfigMatchesAuthType', () => {
  it('requires apiKey config for the api_key auth type', () => {
    expect(() => assertConfigMatchesAuthType({}, CONNECTION_AUTH_TYPE.API_KEY)).toThrow(/API key location and name/);
  });

  it('requires basic config for the basic auth type', () => {
    expect(() => assertConfigMatchesAuthType({}, CONNECTION_AUTH_TYPE.BASIC)).toThrow(/username is required/);
  });

  it('rejects apiKey config on a non-api_key auth type', () => {
    expect(() =>
      assertConfigMatchesAuthType({ apiKey: { location: 'header', name: 'X-Key' } }, CONNECTION_AUTH_TYPE.SECRET),
    ).toThrow(/only applicable to the "api_key"/);
  });

  it('rejects basic config on a non-basic auth type', () => {
    expect(() => assertConfigMatchesAuthType({ basic: { username: 'u' } }, CONNECTION_AUTH_TYPE.NONE)).toThrow(
      /only applicable to the "basic"/,
    );
  });

  it('passes for a coherent config', () => {
    expect(() => assertConfigMatchesAuthType({ apiKey: { location: 'header', name: 'X-Key' } }, CONNECTION_AUTH_TYPE.API_KEY)).not.toThrow();
    expect(() => assertConfigMatchesAuthType({}, CONNECTION_AUTH_TYPE.NONE)).not.toThrow();
  });
});

describe('mergeConnectionConfig — non-destructive update', () => {
  it('keeps everything when the patch is empty', () => {
    const existing = { baseUrl: 'https://a.example.com', basic: { username: 'u' } };
    expect(mergeConnectionConfig(existing, {})).toEqual(existing);
  });

  it('replaces only the fields present in the patch', () => {
    const existing = { baseUrl: 'https://a.example.com', basic: { username: 'u' } };
    const merged = mergeConnectionConfig(existing, { baseUrl: 'https://b.example.com' });
    expect(merged.baseUrl).toBe('https://b.example.com');
    expect(merged.basic).toEqual({ username: 'u' }); // untouched
  });

  it('merges resources per-key rather than wholesale replacing the map', () => {
    const existing = { resources: { customer: { enabled: true }, staff: { enabled: false } } };
    const merged = mergeConnectionConfig(existing, { resources: { customer: { enabled: false } } });
    expect(merged.resources).toEqual({ customer: { enabled: false }, staff: { enabled: false } });
  });

  it('merges advanced.endpoints and advanced.headers per-key', () => {
    const existing = {
      advanced: { endpoints: { customer: '/c', staff: '/s' }, headers: { 'X-A': '1' }, cursorField: 'updatedAt' },
    };
    const merged = mergeConnectionConfig(existing, {
      advanced: { endpoints: { customer: '/customers-v2' }, headers: { 'X-B': '2' } },
    });
    expect(merged.advanced?.endpoints).toEqual({ customer: '/customers-v2', staff: '/s' });
    expect(merged.advanced?.headers).toEqual({ 'X-A': '1', 'X-B': '2' });
    expect(merged.advanced?.cursorField).toBe('updatedAt'); // untouched
  });

  it('starts from nothing when there is no existing config', () => {
    expect(mergeConnectionConfig(null, { baseUrl: 'https://a.example.com' })).toEqual({ baseUrl: 'https://a.example.com' });
  });
});

describe('resourceDirectionOf / isResourceEnabled', () => {
  it('defaults a resource to enabled when unspecified', () => {
    expect(isResourceEnabled(null, 'staff' as never)).toBe(true);
    expect(isResourceEnabled({ resources: {} }, 'staff' as never)).toBe(true);
  });

  it('honours an explicit disable', () => {
    expect(isResourceEnabled({ resources: { staff: { enabled: false } } }, 'staff' as never)).toBe(false);
  });

  it('falls back to the connection default direction when unspecified', () => {
    expect(resourceDirectionOf(null, 'staff' as never, 'inbound' as never)).toBe('inbound');
  });

  it('honours a per-resource direction override', () => {
    const config = { resources: { staff: { enabled: true, direction: 'outbound' as never } } };
    expect(resourceDirectionOf(config, 'staff' as never, 'bidirectional' as never)).toBe('outbound');
  });
});

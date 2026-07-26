import { IntegrationConnectionService } from './integration-connection.service';
import { CONNECTION_AUTH_TYPE, CONNECTION_STATUS } from '../integration-platform.constants';

function repoMock(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn((x) => Promise.resolve({ id: 'c1', ...x })),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
    ...over,
  } as any;
}

const encryption = {
  encrypt: jest.fn((v: string) => `ENC:${v}`),
  decrypt: jest.fn((v: string) => v.replace('ENC:', '')),
} as any;
const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
const providers = { capabilitiesOf: jest.fn(), healthCheck: jest.fn() } as any;
const admission = { admit: jest.fn().mockResolvedValue(undefined) } as any;
const idMap = { retentionImpact: jest.fn(), transferMappings: jest.fn(), purgeForConnection: jest.fn() } as any;

function build(repo: any) {
  return new IntegrationConnectionService(repo, encryption, audit, providers, admission, idMap);
}

const actor = { userId: 'u1', ip: '1.2.3.4' };
const tenantId = 't1';

describe('IntegrationConnectionService.create — auth types', () => {
  it('none: no credential, no base URL required (custom provider)', async () => {
    const repo = repoMock();
    const svc = build(repo);
    const saved = await svc.create(tenantId, { name: 'N', provider: 'custom', authType: CONNECTION_AUTH_TYPE.NONE } as any, actor);
    expect(saved.hasCredential).toBe(false);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ credentials_ciphertext: null }));
  });

  it('none: rejects a manually supplied credential', async () => {
    const svc = build(repoMock());
    await expect(
      svc.create(tenantId, { name: 'N', provider: 'custom', authType: CONNECTION_AUTH_TYPE.NONE, credential: 'x' } as any, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('api_key: requires both a credential and config.apiKey (location/name)', async () => {
    const svc = build(repoMock());
    await expect(
      svc.create(
        tenantId,
        { name: 'N', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.API_KEY, config: { baseUrl: 'https://api.example.com' } } as any,
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const repo = repoMock();
    const saved = await build(repo).create(
      tenantId,
      {
        name: 'N',
        provider: 'generic_rest',
        authType: CONNECTION_AUTH_TYPE.API_KEY,
        credential: 'key-123',
        config: { baseUrl: 'https://api.example.com', apiKey: { location: 'header', name: 'X-Api-Key' } },
      } as any,
      actor,
    );
    expect(saved.hasCredential).toBe(true);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ credentials_ciphertext: 'ENC:key-123' }));
  });

  it('secret (Bearer token): requires only the credential', async () => {
    const repo = repoMock();
    const saved = await build(repo).create(
      tenantId,
      { name: 'N', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.SECRET, credential: 'tok', config: { baseUrl: 'https://api.example.com' } } as any,
      actor,
    );
    expect(saved.hasCredential).toBe(true);
  });

  it('basic: requires both config.basic.username and the credential (password)', async () => {
    const svc = build(repoMock());
    await expect(
      svc.create(
        tenantId,
        { name: 'N', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.BASIC, credential: 'pw', config: { baseUrl: 'https://api.example.com' } } as any,
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // missing basic.username

    await expect(
      svc.create(
        tenantId,
        { name: 'N', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.BASIC, config: { baseUrl: 'https://api.example.com', basic: { username: 'u' } } } as any,
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // missing password

    const repo = repoMock();
    const saved = await build(repo).create(
      tenantId,
      {
        name: 'N',
        provider: 'generic_rest',
        authType: CONNECTION_AUTH_TYPE.BASIC,
        credential: 'pw',
        config: { baseUrl: 'https://api.example.com', basic: { username: 'u' } },
      } as any,
      actor,
    );
    expect(saved.hasCredential).toBe(true);
  });

  it('oauth2: rejects a manually supplied credential ("connect flow, not manual secrets")', async () => {
    // generic_rest does not declare oauth2 support today (no provider does),
    // so this is also exercised at the provider-authType-mismatch layer.
    const svc = build(repoMock());
    await expect(
      svc.create(tenantId, { name: 'N', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.OAUTH2, credential: 'x' } as any, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('IntegrationConnectionService.create — base URL requirement', () => {
  it('requires a base URL for generic_rest', async () => {
    const svc = build(repoMock());
    await expect(svc.create(tenantId, { name: 'N', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.NONE } as any, actor)).rejects.toMatchObject(
      { code: 'VALIDATION_ERROR' },
    );
  });

  it('rejects a base URL for "custom" (no real adapter)', async () => {
    const svc = build(repoMock());
    await expect(
      svc.create(tenantId, { name: 'N', provider: 'custom', authType: CONNECTION_AUTH_TYPE.NONE, config: { baseUrl: 'https://x.example.com' } } as any, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('normalizes a trailing slash on the stored base URL', async () => {
    const repo = repoMock();
    await build(repo).create(
      tenantId,
      { name: 'N', provider: 'generic_rest', authType: CONNECTION_AUTH_TYPE.NONE, config: { baseUrl: 'https://api.example.com/v1/' } } as any,
      actor,
    );
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ baseUrl: 'https://api.example.com/v1' }) }));
  });
});

describe('IntegrationConnectionService.update — never erases on a blank field', () => {
  function existingConnection(over: Record<string, unknown> = {}) {
    return {
      id: 'c1',
      name: 'Old name',
      provider: 'generic_rest',
      auth_type: CONNECTION_AUTH_TYPE.SECRET,
      credentials_ciphertext: 'ENC:old-token',
      config: { baseUrl: 'https://api.example.com', advanced: { headers: { 'X-A': '1' } } },
      status: CONNECTION_STATUS.ACTIVE,
      sync_direction: 'bidirectional',
      default_conflict_policy: 'reject_and_report',
      deleted_at: null,
      ...over,
    };
  }

  it('leaves the stored credential untouched when `credential` is omitted from the update', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existingConnection()) });
    const svc = build(repo);
    await svc.update(tenantId, 'c1', { name: 'New name' } as any, actor);
    const savedArg = repo.save.mock.calls[0][0];
    expect(savedArg.credentials_ciphertext).toBe('ENC:old-token');
  });

  it('rotates the credential when a new one IS supplied', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existingConnection()) });
    const svc = build(repo);
    await svc.update(tenantId, 'c1', { credential: 'new-token' } as any, actor);
    const savedArg = repo.save.mock.calls[0][0];
    expect(savedArg.credentials_ciphertext).toBe('ENC:new-token');
  });

  it('clears the credential when explicitly set to an empty string', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existingConnection({ auth_type: CONNECTION_AUTH_TYPE.NONE })) });
    const svc = build(repo);
    await svc.update(tenantId, 'c1', { credential: '' } as any, actor);
    const savedArg = repo.save.mock.calls[0][0];
    expect(savedArg.credentials_ciphertext).toBeNull();
  });

  it('leaves the stored config untouched when `config` is omitted', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existingConnection()) });
    const svc = build(repo);
    await svc.update(tenantId, 'c1', { name: 'New name' } as any, actor);
    const savedArg = repo.save.mock.calls[0][0];
    expect(savedArg.config).toEqual({ baseUrl: 'https://api.example.com', advanced: { headers: { 'X-A': '1' } } });
  });

  it('merges a partial config patch instead of replacing the whole object', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existingConnection()) });
    const svc = build(repo);
    await svc.update(tenantId, 'c1', { config: { advanced: { headers: { 'X-B': '2' } } } } as any, actor);
    const savedArg = repo.save.mock.calls[0][0];
    expect(savedArg.config.baseUrl).toBe('https://api.example.com'); // untouched
    expect(savedArg.config.advanced.headers).toEqual({ 'X-A': '1', 'X-B': '2' }); // merged, not replaced
  });

  it('rejects blanking a required base URL to empty string', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(existingConnection()) });
    const svc = build(repo);
    await expect(svc.update(tenantId, 'c1', { config: { baseUrl: '' } } as any, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('IntegrationConnectionService.rotateAuth — safe auth rotation', () => {
  function existingConnection(over: Record<string, unknown> = {}) {
    return {
      id: 'old-1',
      name: 'Old PMS',
      provider: 'generic_rest',
      auth_type: CONNECTION_AUTH_TYPE.API_KEY,
      credentials_ciphertext: 'ENC:old-key',
      config: {
        baseUrl: 'https://api.example.com',
        apiKey: { location: 'header', name: 'X-Api-Key' },
        resources: { staff: { enabled: false } },
      },
      status: CONNECTION_STATUS.ACTIVE,
      sync_direction: 'bidirectional',
      default_conflict_policy: 'reject_and_report',
      deleted_at: null,
      ...over,
    };
  }

  function buildForRotation(existing: ReturnType<typeof existingConnection>) {
    let created = 0;
    const repo = repoMock({
      findOne: jest.fn(({ where }: any) => Promise.resolve(where.id === existing.id ? { ...existing } : null)),
      save: jest.fn((x: any) => {
        if (x.id === existing.id) return Promise.resolve({ ...existing, ...x }); // saving the retired original
        created += 1;
        return Promise.resolve({ id: `new-${created}`, ...x }); // a brand-new replacement row
      }),
    });
    const idMapLocal = { transferMappings: jest.fn().mockResolvedValue({ transferred: 3, skipped: 0 }) } as any;
    const svc = new IntegrationConnectionService(repo, encryption, audit, providers, admission, idMapLocal);
    return { svc, repo, idMapLocal };
  }

  it('creates a replacement connection with the new auth type, transfers mappings, and retires (never deletes) the original', async () => {
    const existing = existingConnection();
    const { svc, repo, idMapLocal } = buildForRotation(existing);

    const result = await svc.rotateAuth(
      tenantId,
      existing.id,
      { authType: CONNECTION_AUTH_TYPE.BASIC, credential: 'new-pw', config: { basic: { username: 'svc' } } } as any,
      actor,
    );

    expect(result.connection.id).not.toBe(existing.id);
    expect(idMapLocal.transferMappings).toHaveBeenCalledWith(tenantId, existing.id, result.connection.id);
    expect(result.mappings).toEqual({ transferred: 3, skipped: 0 });

    const createdSavedArg = repo.save.mock.calls.map((c: any[]) => c[0]).find((x: any) => x.id === undefined);
    expect(createdSavedArg.auth_type).toBe(CONNECTION_AUTH_TYPE.BASIC);
    expect(createdSavedArg.credentials_ciphertext).toBe('ENC:new-pw');
    // Carried over from the original — not re-specified by the caller.
    expect(createdSavedArg.config.baseUrl).toBe('https://api.example.com');
    expect(createdSavedArg.config.resources).toEqual({ staff: { enabled: false } });
    // The OLD auth-specific sub-config never carries over to the new auth type.
    expect(createdSavedArg.config.apiKey).toBeUndefined();
    expect(createdSavedArg.config.basic).toEqual({ username: 'svc' });

    const retiredSavedArg = repo.save.mock.calls.map((c: any[]) => c[0]).find((x: any) => x.id === existing.id);
    expect(retiredSavedArg.status).toBe(CONNECTION_STATUS.DISCONNECTED);
    expect(retiredSavedArg.credentials_ciphertext).toBeNull();
  });

  it('defaults the replacement name and keeps sync direction/conflict policy from the original', async () => {
    const existing = existingConnection({ sync_direction: 'inbound', default_conflict_policy: 'external_wins' });
    const { svc, repo } = buildForRotation(existing);

    await svc.rotateAuth(
      tenantId,
      existing.id,
      { authType: CONNECTION_AUTH_TYPE.SECRET, credential: 'bearer-tok' } as any,
      actor,
    );

    const createdSavedArg = repo.save.mock.calls.map((c: any[]) => c[0]).find((x: any) => x.id === undefined);
    expect(createdSavedArg.name).toBe('Old PMS (rotated)');
    expect(createdSavedArg.sync_direction).toBe('inbound');
    expect(createdSavedArg.default_conflict_policy).toBe('external_wins');
  });
});

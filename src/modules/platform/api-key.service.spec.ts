import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ApiKeyService } from './api-key.service';
import { ApiKey } from '../../entities/System/ApiKey';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let keys: MockRepository;

  beforeEach(async () => {
    keys = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [ApiKeyService, { provide: getRepositoryToken(ApiKey), useValue: keys }],
    }).compile();
    service = moduleRef.get(ApiKeyService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a key, returns the plaintext once, and never leaks the hash', async () => {
    keys.save.mockResolvedValueOnce({ id: 'k1', key_hash: 'secret-hash', name: 'n', permissions: [], is_active: true });
    const res = await service.create(TENANT, { name: 'n', permissions: [] } as any);
    expect(res.apiKey).toEqual(expect.any(String));
    expect(res.apiKey.length).toBeGreaterThan(0);
    expect((res as Record<string, unknown>).key_hash).toBeUndefined();
  });

  it('rotate issues a fresh secret for an existing key', async () => {
    keys.findOne.mockResolvedValueOnce({ id: 'k1', key_hash: 'old' });
    keys.save.mockImplementationOnce(async (k: any) => k);
    const res = await service.rotate(TENANT, 'k1');
    expect(res.apiKey).toEqual(expect.any(String));
  });

  it('revoke deactivates and immediately expires the key', async () => {
    keys.findOne.mockResolvedValueOnce({ id: 'k1', is_active: true });
    keys.save.mockImplementationOnce(async (k: any) => k);
    await service.revoke(TENANT, 'k1');
    const saved = keys.save.mock.calls[0][0];
    expect(saved.is_active).toBe(false);
    expect(saved.expires_at).toBeInstanceOf(Date);
  });

  it('activate / deactivate toggle is_active', async () => {
    keys.findOne.mockResolvedValue({ id: 'k1', is_active: false });
    keys.save.mockImplementation(async (k: any) => k);
    expect((await service.activate(TENANT, 'k1')).is_active).toBe(true);
    expect((await service.deactivate(TENANT, 'k1')).is_active).toBe(false);
  });

  it('findOneOrThrow (via get) throws for an unknown key', async () => {
    keys.findOne.mockResolvedValueOnce(null);
    await expect(service.get(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  describe('authenticate', () => {
    it('rejects a missing key', async () => {
      await expect(service.authenticate(undefined)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('rejects an unknown or inactive key', async () => {
      keys.findOne.mockResolvedValueOnce(null);
      await expect(service.authenticate('plain')).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

      keys.findOne.mockResolvedValueOnce({ id: 'k1', is_active: false });
      await expect(service.authenticate('plain')).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('rejects an expired key', async () => {
      keys.findOne.mockResolvedValueOnce({
        id: 'k1',
        is_active: true,
        expires_at: new Date(Date.now() - 1000),
      });
      await expect(service.authenticate('plain')).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('resolves the principal for a valid key', async () => {
      keys.findOne.mockResolvedValueOnce({
        id: 'k1',
        is_active: true,
        expires_at: null,
        tenant: { id: TENANT },
        permissions: ['payments.read'],
        last_used_at: null,
      });
      const principal = await service.authenticate('plain');
      expect(principal).toEqual({ keyId: 'k1', tenantId: TENANT, permissions: ['payments.read'] });
    });
  });
});

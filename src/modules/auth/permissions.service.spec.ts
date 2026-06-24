import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PermissionsService } from './permissions.service';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let permissions: MockRepository;

  beforeEach(async () => {
    permissions = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionsService,
        { provide: getRepositoryToken(Permission), useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(PermissionsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates a new permission slug', async () => {
      permissions.findOne.mockResolvedValueOnce(null);
      permissions.save.mockResolvedValueOnce({ id: 'p1', slug: 'a.b' });

      const result = await service.create({ slug: 'a.b', name: 'A B', module: 'a' } as any);
      expect(result).toEqual({ id: 'p1', slug: 'a.b' });
    });

    it('rejects a duplicate slug with CONFLICT', async () => {
      permissions.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create({ slug: 'a.b' } as any)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(permissions.save).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('filters by module when provided', async () => {
      await service.findAll('billing');
      expect(permissions.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { module: 'billing' } }),
      );
    });

    it('returns all when no module filter', async () => {
      await service.findAll();
      expect(permissions.find).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });
  });

  describe('findOne', () => {
    it('returns a permission by id', async () => {
      permissions.findOne.mockResolvedValueOnce({ id: 'p1' });
      await expect(service.findOne('p1')).resolves.toEqual({ id: 'p1' });
    });

    it('throws PERMISSION_NOT_FOUND when missing', async () => {
      permissions.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne('nope')).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_NOT_FOUND,
      });
    });
  });

  describe('update / remove', () => {
    it('updates an existing permission', async () => {
      permissions.findOne.mockResolvedValueOnce({ id: 'p1', name: 'old' });
      permissions.save.mockImplementationOnce(async (p: any) => p);
      const result = await service.update('p1', { name: 'new' } as any);
      expect(result).toEqual(expect.objectContaining({ name: 'new' }));
    });

    it('removes an existing permission', async () => {
      permissions.findOne.mockResolvedValueOnce({ id: 'p1' });
      await service.remove('p1');
      expect(permissions.remove).toHaveBeenCalledWith({ id: 'p1' });
    });

    it('throws when removing a missing permission', async () => {
      permissions.findOne.mockResolvedValueOnce(null);
      await expect(service.remove('nope')).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_NOT_FOUND,
      });
    });
  });
});

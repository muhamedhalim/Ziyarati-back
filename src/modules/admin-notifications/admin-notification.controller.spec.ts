import { AdminNotificationController } from './admin-notification.controller';
import { AdminNotificationService } from './admin-notification.service';
import { ROLE } from '../../rbac/rbac.constants';
import { classRoles, guardNames } from '../../../test/utils/route-metadata';

describe('AdminNotificationController', () => {
  let service: jest.Mocked<
    Pick<AdminNotificationService, 'listRecent' | 'unreadCount' | 'markRead' | 'markAllRead'>
  >;
  let controller: AdminNotificationController;

  beforeEach(() => {
    service = {
      listRecent: jest.fn().mockResolvedValue([]),
      unreadCount: jest.fn().mockResolvedValue(3),
      markRead: jest.fn().mockResolvedValue(undefined),
      markAllRead: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AdminNotificationController(service as unknown as AdminNotificationService);
  });

  describe('authorization', () => {
    it('is super-admin only, enforced by RolesGuard on the whole controller', () => {
      expect(classRoles(AdminNotificationController)).toEqual([ROLE.SUPER_ADMIN]);
      expect(guardNames(AdminNotificationController)).toContain('RolesGuard');
    });
  });

  describe('list', () => {
    it('passes a numeric ?limit through and leaves the service default when it is absent', async () => {
      await controller.list('25');
      expect(service.listRecent).toHaveBeenLastCalledWith(25);
      await controller.list(undefined);
      expect(service.listRecent).toHaveBeenLastCalledWith(undefined);
    });

    it('ignores a non-numeric ?limit instead of passing NaN to the query', async () => {
      await controller.list('abc');
      expect(service.listRecent).toHaveBeenLastCalledWith(undefined);
    });
  });

  it('unread-count wraps the number as { count }', async () => {
    await expect(controller.unreadCount()).resolves.toEqual({ count: 3 });
  });

  it('mark-read marks exactly the given id and answers { success: true }', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(controller.markRead(id)).resolves.toEqual({ success: true });
    expect(service.markRead).toHaveBeenCalledWith(id);
  });

  it('read-all marks everything read', async () => {
    await expect(controller.markAllRead()).resolves.toEqual({ success: true });
    expect(service.markAllRead).toHaveBeenCalledTimes(1);
  });
});

describe('AdminNotificationService', () => {
  const repo = {
    save: jest.fn(async (row: unknown) => row),
    create: jest.fn((row: unknown) => row),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const service = new AdminNotificationService(repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('create stores an unread notification and links a tenant only when one is given', async () => {
    await service.create({ type: 'T', title: 'x', tenantId: 'tenant-1' });
    expect(repo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ is_read: false, tenant: { id: 'tenant-1' } }),
    );
    await service.create({ type: 'T', title: 'x' });
    expect(repo.create).toHaveBeenLastCalledWith(expect.objectContaining({ tenant: undefined }));
  });

  it.each([
    [undefined, 50],
    [1000, 200],
    [0, 1],
    [-5, 1],
    [30, 30],
  ])('listRecent(%p) takes %p rows — bounded to 1..200, newest first', async (limit, take) => {
    await service.listRecent(limit as number | undefined);
    expect(repo.find).toHaveBeenLastCalledWith({ order: { created_at: 'DESC' }, take });
  });

  it('unreadCount counts only unread rows', async () => {
    await service.unreadCount();
    expect(repo.count).toHaveBeenCalledWith({ where: { is_read: false } });
  });

  it('markRead updates one row; markAllRead only touches unread rows', async () => {
    await service.markRead('n1');
    expect(repo.update).toHaveBeenLastCalledWith({ id: 'n1' }, expect.objectContaining({ is_read: true }));
    await service.markAllRead();
    expect(repo.update).toHaveBeenLastCalledWith({ is_read: false }, expect.objectContaining({ is_read: true }));
  });
});

import { AiMemoryController } from './ai-memory.controller';
import { PERMISSION } from '../../rbac/rbac.constants';
import { guardNames, handlerPermissions } from '../../../test/utils/route-metadata';

const TENANT = 'tenant-a';
const CONV = '22222222-2222-4222-8222-222222222222';

describe('AiMemoryController', () => {
  const memory = {
    remember: jest.fn(),
    recall: jest.fn(),
    list: jest.fn(),
    summarizeConversation: jest.fn(),
    cleanupExpired: jest.fn(),
    forget: jest.fn(),
  };
  const ctx = { requireTenantId: jest.fn() };
  const controller = new AiMemoryController(memory as never, ctx as never);

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.requireTenantId.mockReturnValue(TENANT);
  });

  describe('authorization', () => {
    it('is behind the permission + active-tenant guards', () => {
      expect(guardNames(AiMemoryController)).toEqual(
        expect.arrayContaining(['PermissionsGuard', 'ActiveTenantGuard']),
      );
    });

    it.each([
      ['remember', PERMISSION.AI_CONVERSATIONS_MANAGE],
      ['summarize', PERMISSION.AI_CONVERSATIONS_MANAGE],
      ['cleanup', PERMISSION.AI_CONVERSATIONS_MANAGE],
      ['forget', PERMISSION.AI_CONVERSATIONS_MANAGE],
      ['recall', PERMISSION.AI_CONVERSATIONS_READ],
      ['list', PERMISSION.AI_CONVERSATIONS_READ],
    ])('%s requires %s', (handler, permission) => {
      expect(handlerPermissions(AiMemoryController, handler)).toEqual([permission]);
    });

    it('no write is reachable with the read permission', () => {
      for (const write of ['remember', 'summarize', 'cleanup', 'forget']) {
        expect(handlerPermissions(AiMemoryController, write)).not.toContain(
          PERMISSION.AI_CONVERSATIONS_READ,
        );
      }
    });
  });

  describe("tenant scoping — every call is made for the caller's tenant", () => {
    it('remember / recall / list / cleanup / forget pass the tenant from the request context', async () => {
      await controller.remember({ content: 'x' } as never);
      expect(memory.remember).toHaveBeenCalledWith(TENANT, { content: 'x' });

      await controller.recall({ query: 'q' } as never);
      expect(memory.recall).toHaveBeenCalledWith(TENANT, { query: 'q' });

      await controller.list({} as never);
      expect(memory.list).toHaveBeenCalledWith(TENANT, {});

      await controller.cleanup();
      expect(memory.cleanupExpired).toHaveBeenCalledWith(TENANT);

      const id = '33333333-3333-4333-8333-333333333333';
      await controller.forget(id);
      expect(memory.forget).toHaveBeenCalledWith(TENANT, id);
    });

    it("summarize reads AND writes inside the caller's own tenant (conversation tenant === memory tenant)", async () => {
      await controller.summarize(CONV);
      expect(memory.summarizeConversation).toHaveBeenCalledWith(TENANT, CONV, undefined, TENANT);
    });

    it('fails closed when there is no tenant in the request context', () => {
      ctx.requireTenantId.mockImplementation(() => {
        throw new Error('no tenant');
      });
      expect(() => controller.cleanup()).toThrow('no tenant');
      expect(memory.cleanupExpired).not.toHaveBeenCalled();
    });
  });
});

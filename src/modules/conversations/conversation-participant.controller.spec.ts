import { Reflector } from '@nestjs/core';

import { ConversationParticipantController } from './conversation-participant.controller';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';

/**
 * VER-008 (REQ-CRM-002) — controller-level proof. Service behavior is proven
 * directly in `conversation-participant.service.spec.ts`; this covers what
 * only the controller owns: every route requires `participants.manage`
 * (never a looser permission), and each handler forwards the CALLER'S OWN
 * tenant (`TenantContextService.requireTenantId()`), never a client-supplied
 * tenant id — there is no tenant param anywhere in this controller's routes,
 * so tenant scoping is entirely `ctx`-derived by construction.
 */
describe('ConversationParticipantController — route authorization (VER-008)', () => {
  const reflector = new Reflector();
  const permissionsOf = (handler: Function) => reflector.get(PERMISSIONS_KEY, handler);

  it('add (POST): requires participants.manage', () => {
    expect(permissionsOf(ConversationParticipantController.prototype.add)).toEqual([PERMISSION.PARTICIPANTS_MANAGE]);
  });

  it('list (GET): requires participants.manage', () => {
    expect(permissionsOf(ConversationParticipantController.prototype.list)).toEqual([PERMISSION.PARTICIPANTS_MANAGE]);
  });

  it('update (PATCH): requires participants.manage', () => {
    expect(permissionsOf(ConversationParticipantController.prototype.update)).toEqual([PERMISSION.PARTICIPANTS_MANAGE]);
  });

  it('remove (DELETE): requires participants.manage', () => {
    expect(permissionsOf(ConversationParticipantController.prototype.remove)).toEqual([PERMISSION.PARTICIPANTS_MANAGE]);
  });
});

describe('ConversationParticipantController — tenant scoping is ctx-derived, never client-supplied (VER-008)', () => {
  function build() {
    const participants = {
      add: jest.fn().mockResolvedValue({ id: 'p1' }),
      list: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockRejectedValue(new Error('unsupported')),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const ctx = { requireTenantId: jest.fn().mockReturnValue('caller-tenant') };
    const controller = new ConversationParticipantController(participants as any, ctx as any);
    return { controller, participants, ctx };
  }

  it('add() forwards ctx.requireTenantId(), not any client-supplied value', async () => {
    const { controller, participants } = build();
    await controller.add('conv-1', { userId: 'u1' } as any);
    expect(participants.add).toHaveBeenCalledWith('caller-tenant', 'conv-1', { userId: 'u1' });
  });

  it('list() forwards ctx.requireTenantId()', async () => {
    const { controller, participants } = build();
    await controller.list('conv-1');
    expect(participants.list).toHaveBeenCalledWith('caller-tenant', 'conv-1');
  });

  it('remove() forwards ctx.requireTenantId()', async () => {
    const { controller, participants } = build();
    await controller.remove('conv-1', 'p1');
    expect(participants.remove).toHaveBeenCalledWith('caller-tenant', 'conv-1', 'p1');
  });
});

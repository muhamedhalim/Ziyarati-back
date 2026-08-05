import { Reflector } from '@nestjs/core';

import { EmailLogController } from './email-log.controller';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * VER-016 (REQ-NOTIF-002) — platform email delivery logs must remain
 * super-admin-only (cross-tenant by design — proven in
 * email-delivery.service.spec.ts).
 */
describe('EmailLogController — super-admin only (VER-016)', () => {
  it('the whole controller is gated at the class level — every route, current and future, inherits it', () => {
    const roles = new Reflector().get(ROLES_KEY, EmailLogController);
    expect(roles).toEqual([ROLE.SUPER_ADMIN]);
  });
});

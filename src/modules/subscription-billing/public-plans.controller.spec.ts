import {
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ROLE } from '../../rbac/rbac.constants';
import { PublicPlansController } from './public-plans.controller';
import { PlatformBillingAdminController } from './platform-billing-admin.controller';

describe('PublicPlansController', () => {
  const handler = PublicPlansController.prototype.list;

  it('is mounted at GET /public/plans', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicPlansController)).toBe(
      'public/plans',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
  });

  it('is anonymous (@Public) so the marketing site can call it', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
  });

  it('is never cacheable, so a deactivated plan cannot linger', () => {
    const headers = Reflect.getMetadata(HEADERS_METADATA, handler) as Array<{
      name: string;
      value: string;
    }>;
    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
  });

  it('exposes read-only access only: the controller has no mutating handler', () => {
    const methods = Object.getOwnPropertyNames(
      PublicPlansController.prototype,
    ).filter((n) => n !== 'constructor');
    for (const name of methods) {
      const fn = (PublicPlansController.prototype as never)[
        name
      ] as () => unknown;
      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.GET);
    }
  });

  it('plan mutation stays on the super-admin controller: not public, and restricted to super_admin', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, PlatformBillingAdminController),
    ).toEqual([ROLE.SUPER_ADMIN]);
    for (const name of [
      'createPlan',
      'updatePlan',
      'activatePlan',
      'deactivatePlan',
    ]) {
      const fn = (PlatformBillingAdminController.prototype as never)[
        name
      ] as () => unknown;
      expect(typeof fn).toBe('function');
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, fn)).toBeUndefined();
    }
  });
});

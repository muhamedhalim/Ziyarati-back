import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';

import { SystemSettingService } from '../system-setting.service';
import { SettingKey } from '../settings.registry';
import { ROLE } from '../../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * MaintenanceGuard — blocks all non-super-admin requests when
 * `platform.maintenance_mode` is enabled. Runs after JwtAuthGuard so that
 * `request.user` is already populated.
 *
 * Public (unauthenticated) routes pass through; super-admins bypass the gate
 * so they can log in and disable maintenance mode without needing out-of-band
 * access.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly settings: SystemSettingService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isMaintenance = await this.settings.getTyped<boolean>(SettingKey.MAINTENANCE_MODE);
    if (!isMaintenance) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!req.user) return true; // unauthenticated / public routes pass through
    if (req.user.roles?.includes(ROLE.SUPER_ADMIN)) return true;

    // A dedicated code (not the generic SERVICE_UNAVAILABLE) so clients can tell real
    // maintenance from any other 503 (CR-04).
    throw new AppError(ErrorCode.MAINTENANCE_MODE);
  }
}

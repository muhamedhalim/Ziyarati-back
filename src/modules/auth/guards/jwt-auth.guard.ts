import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_API_KEY_ROUTE_KEY } from '../decorators/api-key-route.decorator';
import { ApiKeyAuthGuard } from '../../platform/guards/api-key-auth.guard';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * Authenticates every request using the JWT strategy, unless the handler (or
 * its controller) is annotated with @Public(). Intended to be registered as a
 * global guard so endpoints are secure by default.
 *
 * `@Public()` routes additionally marked `@ApiKeyRoute()` (applied internally
 * by `@ApiKeyProtected()`) are authenticated here via ApiKeyAuthGuard instead
 * of being treated as genuinely open. This MUST happen inside this global
 * guard rather than a route-level one: Nest runs every global guard
 * (JwtAuthGuard, MaintenanceGuard, ...) before any controller/method-level
 * `@UseGuards()`, so a route-level-only API-key guard would leave
 * `request.user` unset when MaintenanceGuard (and any other global guard that
 * inspects the principal) makes its decision — silently bypassing tenant
 * suspension / maintenance-mode enforcement for API-key traffic. Resolving
 * the key here closes that gap: whichever credential type is used, the
 * principal exists before any later global guard runs.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeyAuth: ApiKeyAuthGuard,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      const isApiKeyRoute = this.reflector.getAllAndOverride<boolean>(
        IS_API_KEY_ROUTE_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (isApiKeyRoute) {
        return this.apiKeyAuth.canActivate(context);
      }
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new AppError(ErrorCode.UNAUTHORIZED);
    }
    return user;
  }
}

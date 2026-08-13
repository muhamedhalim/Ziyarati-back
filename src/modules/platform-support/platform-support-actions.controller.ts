import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

import { SupportActionsService } from './support-actions.service';
import { SUPPORT_ACTION_THROTTLE } from './platform-support.constants';

/**
 * ============================================================================
 *  SUPPORT OPERATIONS CONSOLE — safe recovery actions
 * ============================================================================
 *
 * The ENTIRE write surface available to Platform Customer Service. Three
 * routes, each targeting exactly one record, each behind its own permission.
 *
 * Observe what is NOT here, and cannot be added by accident: no bulk route, no
 * route without an `:id`, and **no route with a request body at all**. There is
 * literally no DTO for a support agent to populate — no destination, no
 * template, no payload, no status. That is what makes "never let Platform
 * Support construct a raw email payload / choose an arbitrary template / alter
 * the destination" a structural property rather than a validation rule.
 *
 * Every route is throttled per actor, because each causes a real outbound
 * message or a real provider probe, and every route writes an audit row naming
 * the actual platform employee — including when the action is REFUSED.
 */
@ApiTags('Platform Support — Safe Actions')
@ApiBearerAuth('JWT-auth')
@Controller('platform/support/clinics')
@UseGuards(PermissionsGuard)
@Throttle(SUPPORT_ACTION_THROTTLE)
export class PlatformSupportActionsController {
  constructor(private readonly actions: SupportActionsService) {}

  @ApiOperation({
    summary: 'Resend one eligible invitation email',
    description:
      "Identifies a RECORD in the clinic's email history, never a recipient. The template must be " +
      'on the resendable allow-list; the destination, locale and a fresh single-use token are ' +
      "re-resolved server-side from the staff member's user record by the same service the " +
      "clinic's own Owner uses. Takes no request body. Refusals are audited too.",
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'emailLogId',
    description: 'email_logs row UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Invitation re-issued and re-sent.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_EMAIL_RESEND)
  @Post(':tenantId/emails/:emailLogId/resend')
  resendEmail(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('emailLogId', ParseUUIDPipe) emailLogId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.actions.resendEmail(tenantId, emailLogId, user.id);
  }

  @ApiOperation({
    summary: 'Retry one failed notification',
    description:
      "Delegates to the notification domain's own audited retry override, which refuses anything " +
      'outside FAILED / SEND_UNCERTAIN and clears the duplicate-send guard. One notification per ' +
      'call — there is no retry-all anywhere in this module, and no raw queue access.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'notificationId',
    description: 'Scheduled notification UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Notification re-queued.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_RETRY)
  @Post(':tenantId/notifications/:notificationId/retry')
  retryNotification(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.actions.retryNotification(tenantId, notificationId, user.id);
  }

  @ApiOperation({
    summary: 'Re-probe integration health',
    description:
      'A read that is a POST because it is an explicit, attributable operator action. Reconnects ' +
      'nothing, rotates no token, changes no credential or webhook configuration and writes no ' +
      'integration state — it re-runs the same health queries as the integrations view plus a live ' +
      'queue-backend ping, and records who triggered it and when.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Freshly probed integration health.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_RECHECK)
  @Post(':tenantId/integrations/recheck')
  recheckIntegrations(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.actions.recheckIntegrations(tenantId, user.id);
  }
}

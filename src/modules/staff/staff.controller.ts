import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { StaffService } from './staff.service';
import { StaffAccessService } from './staff-access.service';
import { StaffScheduleService } from './staff-schedule.service';
import { StaffTimeOffService } from './staff-time-off.service';
import { StaffCommissionService } from './staff-commission.service';
import { StaffRatingService } from './staff-rating.service';
import { StaffScopeService } from '../../core/staff-scope/staff-scope.service';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { QueryStaffDto } from './dto/query-staff.dto';
import { EligibleUsersQueryDto } from './dto/eligible-users-query.dto';
import { CreateStaffWithNewUserDto } from './dto/create-staff-with-new-user.dto';

import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { AssignServicesDto } from './dto/assign-services.dto';
import { AssignBranchesDto } from './dto/assign-branches.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { CreateTimeOffDto } from './dto/create-time-off.dto';
import { CreateCommissionDto } from './dto/create-commission.dto';
import { CommissionSummaryQueryDto } from './dto/commission-summary.query.dto';
import { CreateStaffRatingDto } from './dto/create-staff-rating.dto';
import { AvailabilityQueryDto } from './dto/availability.query.dto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

// ─── Reusable inline response schema fragments ────────────────────────────────

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const S_STAFF = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string', nullable: true, example: 'Senior Dermatologist' },
    bio: { type: 'string', nullable: true },
    avatar_url: {
      type: 'string',
      nullable: true,
      description:
        'Short-lived signed URL when an avatar was uploaded via `POST /uploads`; re-fetch the resource once it expires.',
    },
    booking_buffer_minutes: { type: 'number', example: 10 },
    is_available_for_booking: { type: 'boolean', example: true },
    role: {
      type: 'object',
      nullable: true,
      description:
        "The linked account's currently held role (null if it holds zero or more than one).",
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string', example: 'doctor' },
        name: { type: 'string', example: 'Doctor' },
        isCustom: {
          type: 'boolean',
          description: 'True for a synthesized "Other" role.',
        },
        permissionSlugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Present only when isCustom is true.',
        },
      },
    },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        full_name: { type: 'string', example: 'Dr. Ahmed Hassan' },
        email: { type: 'string', nullable: true },
      },
    },
    staffServices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          service: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_STAFF_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_STAFF },
    total: { type: 'number', example: 23 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

const S_ELIGIBLE_USER = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    fullName: { type: 'string', nullable: true, example: 'Sara Al-Amin' },
    email: { type: 'string', nullable: true, example: 'sara@al-noor.com' },
    role: {
      type: 'object',
      nullable: true,
      properties: {
        slug: { type: 'string', example: 'receptionist' },
        name: { type: 'string', example: 'Receptionist' },
      },
    },
  },
};

const S_ELIGIBLE_USER_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_ELIGIBLE_USER },
    total: { type: 'number', example: 4 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 10 },
  },
};

const S_STAFF_WITH_CREDENTIALS = {
  type: 'object',
  properties: {
    profile: S_STAFF,
    temporaryPassword: {
      type: 'string',
      description:
        'Generated once — never retrievable again. Share it with the new staff member out of band.',
      example: 'aZ3f9Qk2mN7p',
    },
  },
};

const S_SCHEDULE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    day_of_week: {
      type: 'number',
      example: 1,
      description: '0=Sunday … 6=Saturday',
    },
    start_time: { type: 'string', example: '09:00' },
    end_time: { type: 'string', example: '13:00' },
    is_active: { type: 'boolean', example: true },
    branch: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
  },
};

const S_TIME_OFF = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    start_date: { type: 'string', format: 'date' },
    end_date: { type: 'string', format: 'date' },
    reason: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_COMMISSION = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    commission_type: {
      type: 'string',
      enum: ['PERCENT', 'FIXED'],
      example: 'PERCENT',
    },
    commission_value: { type: 'number', example: 15 },
    service: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_COMMISSION_SUMMARY = {
  type: 'object',
  properties: {
    staffId: { type: 'string', format: 'uuid' },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    appointmentsCount: { type: 'number', example: 42 },
    totalBaseAmount: { type: 'number', example: 12600.0 },
    totalCommission: { type: 'number', example: 1890.0 },
    breakdown: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', format: 'uuid' },
          serviceName: { type: 'string' },
          count: { type: 'number' },
          base: { type: 'number' },
          commission: { type: 'number' },
        },
      },
    },
    rulesApplied: { type: 'number', example: 3 },
  },
};

const S_RATING_LIST = {
  type: 'object',
  properties: {
    staffId: { type: 'string', format: 'uuid' },
    count: { type: 'number', example: 18 },
    average: { type: 'number', example: 4.6 },
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          rating: { type: 'number', example: 5 },
          comment: { type: 'string', nullable: true },
          customer: {
            type: 'object',
            nullable: true,
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          appointment: {
            type: 'object',
            nullable: true,
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

const S_AVAILABILITY = {
  type: 'object',
  properties: {
    date: { type: 'string', format: 'date', example: '2026-06-15' },
    branchId: { type: 'string', format: 'uuid' },
    dayOfWeek: { type: 'number', example: 1 },
    open: { type: 'boolean', example: true },
    branchHours: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'string', example: '08:00' },
          end: { type: 'string', example: '18:00' },
        },
      },
    },
    staff: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          staffId: { type: 'string', format: 'uuid' },
          title: { type: 'string', nullable: true },
          name: { type: 'string', nullable: true },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                start: { type: 'string', example: '09:00' },
                end: { type: 'string', example: '13:00' },
              },
            },
          },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Staff domain — profiles, scheduling, service/branch assignment, time off,
 * commissions, ratings and availability.
 *
 * Guards: PermissionsGuard (RBAC per handler) + ActiveTenantGuard (clinic must
 * be approved + active). Tenant id is read from TenantContext, never the body.
 */
@ApiTags('Staff')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.STAFF)
@Controller('staff')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly access: StaffAccessService,
    private readonly schedules: StaffScheduleService,
    private readonly timeOff: StaffTimeOffService,
    private readonly commissions: StaffCommissionService,
    private readonly ratings: StaffRatingService,
    private readonly ctx: TenantContextService,
    /** The one authority on "which StaffProfile, if any, IS this caller". */
    private readonly staffScope: StaffScopeService,
  ) {}

  // ───────────────────────────── Profiles ────────────────────────────────── //

  @ApiOperation({
    summary: 'Create a staff profile',
    description: `
**Protected — requires \`staff.create\`. Clinic must be active.**

Turns an EXISTING clinic user into a bookable staff member. Create the
user first via the auth flow (\`POST /auth/register-user\`), then link it here.

**Business rules**
- The user must belong to the caller's clinic (tenant isolation).
- One staff profile per user (409 on a second attempt).

**Who can call this:** Owner, Manager (\`staff.create\`).
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Staff profile created.',
    schema: S_STAFF,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Referenced user not found in this clinic.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'This user already has a staff profile.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.STAFF_CREATE)
  create(@Body() dto: CreateStaffDto) {
    return this.staff.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Create a staff member with a brand-new user account',
    description: `
**Protected — requires \`staff.create\`. Clinic must be active.**

The "Create new user" Add Staff Member path: provisions the User account, its
role, and the StaffProfile together, atomically — if any step fails, nothing
is created. Replaces the old two-step "create a user via another screen, copy
its UUID, paste it here" flow.

No password field: a temporary password is generated server-side and
returned **once** in the response (\`temporaryPassword\`) — it cannot be
retrieved again. The same password is also emailed to the new staff member
(best-effort; a delivery failure never fails this request), so sharing it out
of band is a fallback, not the only channel.

**Business rules**
- Email must be unique within the clinic.
- \`roleSlug\` may be any role \`GET /staff/assignable-roles\` returns (the
  tenant's own custom roles or a system role); defaults to \`receptionist\`.
  Founding/platform roles (\`owner\`, \`super_admin\`) and non-staff system
  roles (\`customer\`, \`ai-bot\`) are rejected even if forced directly.
- Pass \`roleSlug: "other"\` with a non-empty \`permissionSlugs\` to instead
  synthesize a tenant-scoped custom role carrying exactly those permissions.
  Every slug must already be a permission the CALLER holds — see
  \`GET /staff/assignable-permissions\`.
- Subject to the plan's \`max_users\` limit.
- Optional \`branchIds\` are validated and assigned in the same transaction.

**Who can call this:** Owner, Manager (\`staff.create\`).
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'User + staff profile created.',
    schema: S_STAFF_WITH_CREDENTIALS,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, primaryBranchId not in branchIds, or roleSlug is "other" with an empty permissionSlugs.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `staff.create`, attempted a privileged role, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Email address already exists within this clinic.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Plan user limit reached, or a branch was not found in this clinic.',
    schema: S_ERROR,
  })
  @Post('from-new-user')
  @RequirePermissions(PERMISSION.STAFF_CREATE)
  createFromNewUser(
    @Body() dto: CreateStaffWithNewUserDto,
    @CurrentUser('permissions') callerPermissions: string[],
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.staff.createWithNewUser(
      this.ctx.requireTenantId(),
      dto,
      callerPermissions,
      actorUserId,
    );
  }

  @ApiOperation({
    summary: 'Search users eligible to become staff ("Link existing user")',
    description: `
**Protected — requires \`staff.create\`. Clinic must be active.**

Returns clinic users that can be turned into a staff profile: active,
belonging to the caller's clinic, and without a staff profile already. Never
exposes anything beyond \`id\`/\`fullName\`/\`email\`/\`role\` — the frontend
never displays or lets the admin type a UUID.

**Who can call this:** Owner, Manager (\`staff.create\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Eligible users.',
    schema: S_ELIGIBLE_USER_LIST,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('eligible-users')
  @RequirePermissions(PERMISSION.STAFF_CREATE)
  findEligibleUsers(@Query() query: EligibleUsersQueryDto) {
    return this.staff.findEligibleUsers(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'List roles assignable to a staff member ("Create new user")',
    description: `
**Protected — requires \`staff.create\`. Clinic must be active.**

Returns the roles this tenant may assign when creating a new staff user:
the tenant's own custom roles plus shared system roles — EXCLUDING founding/
platform roles (\`owner\`, \`super_admin\`) and roles that aren't for human
staff (\`customer\`, \`ai-bot\`). Dynamic: a newly created custom tenant role
appears here automatically, with no code change. The same exclusion is
re-enforced server-side on \`POST /staff/from-new-user\` — this endpoint only
drives the dropdown.

**Who can call this:** Owner, Manager (\`staff.create\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Assignable roles.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          slug: { type: 'string', example: 'receptionist' },
          name: { type: 'string', example: 'Receptionist' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('assignable-roles')
  @RequirePermissions(PERMISSION.STAFF_CREATE)
  findAssignableRoles() {
    return this.staff.findAssignableRoles(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary:
      'List permissions the caller may grant via the "Other" role ("Create new user")',
    description: `
**Protected — requires \`staff.create\`. Clinic must be active.**

Returns the permission catalogue entries the CALLER themselves currently
holds — always a subset of the full catalogue, never all of it. Backs the
permissions checklist shown when \`roleSlug\` is set to the reserved value
\`"other"\` on \`POST /staff/from-new-user\` / \`PATCH /staff/:id\`: since the
selector only ever offers permissions the caller already has, there is no
way to request one that will be rejected server-side (the same
privilege-escalation guard is re-enforced on the write endpoints
regardless of what the client sends).

**Who can call this:** Owner, Manager (\`staff.create\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Permissions the caller may grant.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          slug: { type: 'string', example: 'appointments.read' },
          name: { type: 'string', example: 'Read appointments' },
          module: { type: 'string', nullable: true, example: 'appointments' },
          description: { type: 'string', nullable: true },
          scope: { type: 'string', example: 'tenant' },
          isOwnershipScoped: { type: 'boolean' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('assignable-permissions')
  @RequirePermissions(PERMISSION.STAFF_CREATE)
  findAssignablePermissions(
    @CurrentUser('permissions') callerPermissions: string[],
  ) {
    return this.staff.findAssignablePermissions(callerPermissions);
  }

  @ApiOperation({
    summary: "Preview a role's full permission set (informational only)",
    description: `
**Protected — requires \`staff.create\`. Clinic must be active.**

Returns the FULL permission set granted by a role from \`GET
/staff/assignable-roles\` — grouped/labelled for the read-only preview shown
under the role selector once a predefined role (Doctor/Manager/Receptionist)
or a tenant custom role is picked, so the clinic owner sees exactly what that
role grants before the employee is created.

Unlike \`GET /staff/assignable-permissions\` (which is filtered to what the
CALLER holds, for the "Other" checklist), this always returns the role's
actual permission set, whoever the caller is — it is a preview, not a grant
selector. Creating the staff member re-resolves and enforces the role's
permissions server-side exactly as today; this endpoint changes nothing
about what gets granted.

**Who can call this:** Owner, Manager (\`staff.create\`).
    `.trim(),
  })
  @ApiParam({
    name: 'roleId',
    description: 'A role id from `GET /staff/assignable-roles`.',
  })
  @ApiOkResponse({
    description: "The role's permissions.",
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          slug: { type: 'string', example: 'appointments.read_own' },
          name: { type: 'string', example: 'Read own appointments' },
          module: { type: 'string', nullable: true, example: 'appointments' },
          description: { type: 'string', nullable: true },
          scope: { type: 'string', example: 'tenant' },
          isOwnershipScoped: { type: 'boolean' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `staff.create`, the role cannot be assigned to staff, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Role not found or not visible to this tenant.',
    schema: S_ERROR,
  })
  @Get('assignable-roles/:roleId/permissions')
  @RequirePermissions(PERMISSION.STAFF_CREATE)
  findAssignableRolePermissions(
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ) {
    return this.staff.findAssignableRolePermissions(
      roleId,
      this.ctx.requireTenantId(),
    );
  }

  @ApiOperation({
    summary: 'List staff (filtered + paginated)',
    description: `
**Protected — requires \`staff.read\`. Clinic must be active.**

Returns the clinic's staff. Optional filters: \`search\` (title),
\`isAvailable\`, \`branchId\` (resolved via branch assignments), and \`role\`
(the linked account's currently held role slug, e.g. \`doctor\` — backs a
doctor-only staff picker).

**Who can call this:** Owner, Manager, Receptionist (\`staff.read\`).

**Tenant scoping:** Only the caller's clinic staff are returned.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated staff list.', schema: S_STAFF_LIST })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.STAFF_READ)
  findAll(
    @Query() query: QueryStaffDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.staff.findAll(this.ctx.requireTenantId(), query, {
      id: user.id,
      permissions: user.permissions,
    });
  }

  @ApiOperation({
    summary: 'Get staff availability by branch and date',
    description: `
**Protected — requires \`staff.read\`. Clinic must be active.**

Returns which staff are bookable at a branch on a date, with concrete time
windows = each staff member's active schedule slots **intersected with the
branch's open working hours**, excluding staff who are not bookable or are
on time off that day.

Used by the booking UI and the WhatsApp availability bot.

**Edge cases:** if the branch has no open working hours for that weekday,
\`open=false\` and \`staff=[]\`.

**Who can call this:** Owner, Manager, Receptionist (\`staff.read\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Computed availability.',
    schema: S_AVAILABILITY,
  })
  @ApiBadRequestResponse({
    description: 'Invalid branchId or date.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Branch not found in this clinic.',
    schema: S_ERROR,
  })
  @Get('availability')
  @RequirePermissions(PERMISSION.STAFF_READ)
  availability(@Query() query: AvailabilityQueryDto) {
    return this.schedules.getAvailability(
      this.ctx.requireTenantId(),
      query.branchId,
      query.date,
    );
  }

  // ────────────────────────── Own profile ("me") ──────────────────────────── //
  //
  // Three routes for a caller who holds only `staff.read_own` (today: the
  // `doctor` role — see rbac.constants.ts) and no `staff.read` at all. `me`
  // is a literal path segment, not a param: the caller's own StaffProfile id
  // comes from `StaffScopeService.resolveOwnStaffId`, and NO id is ever
  // accepted from the client on these three routes. There is therefore no
  // IDOR surface to defend here — the request shape itself makes "ask for
  // someone else's profile" inexpressible, which is why these are declared
  // as `me`, not as a widened `GET /staff/:id`. Declared BEFORE `@Get(':id')`
  // below: NestJS matches route patterns in registration order, and `me`
  // would otherwise be swallowed by the `:id` param.

  @ApiOperation({
    summary: "Get the caller's own staff profile",
    description: `
**Protected — requires \`staff.read_own\`. Clinic must be active.**

Returns the CALLER's own staff profile — never another staff member's; no id
is accepted in the request. 404 if the caller has no StaffProfile in this
tenant.

**Who can call this:** Doctor (\`staff.read_own\`), or any other role future
work delegates this permission to.
    `.trim(),
  })
  @ApiOkResponse({ description: "The caller's own staff profile.", schema: S_STAFF })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read_own`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'The caller has no StaffProfile in this tenant.',
    schema: S_ERROR,
  })
  @Get('me')
  @RequirePermissions(PERMISSION.STAFF_READ_OWN)
  async findOwn(@CurrentUser() user: AuthenticatedUser) {
    const tenantId = this.ctx.requireTenantId();
    const ownId = await this.staffScope.resolveOwnStaffId(tenantId, user.id);
    if (!ownId) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    return this.staff.findOne(tenantId, ownId);
  }

  @ApiOperation({
    summary: "List the caller's own weekly schedule",
    description: `**Protected — requires \`staff.read_own\`. Clinic must be active.** Returns the CALLER's own schedule slots only; 404 if they have no StaffProfile.`,
  })
  @ApiOkResponse({
    description: "The caller's own schedule slots.",
    schema: { type: 'array', items: S_SCHEDULE },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read_own`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'The caller has no StaffProfile in this tenant.',
    schema: S_ERROR,
  })
  @Get('me/schedules')
  @RequirePermissions(PERMISSION.STAFF_READ_OWN)
  async findOwnSchedules(@CurrentUser() user: AuthenticatedUser) {
    const tenantId = this.ctx.requireTenantId();
    const ownId = await this.staffScope.resolveOwnStaffId(tenantId, user.id);
    if (!ownId) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    return this.schedules.listSchedules(tenantId, ownId);
  }

  @ApiOperation({
    summary: "List the caller's own time off",
    description: `**Protected — requires \`staff.read_own\`. Clinic must be active.** Returns the CALLER's own time-off records only; 404 if they have no StaffProfile.`,
  })
  @ApiOkResponse({
    description: "The caller's own time-off records.",
    schema: { type: 'array', items: S_TIME_OFF },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read_own`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'The caller has no StaffProfile in this tenant.',
    schema: S_ERROR,
  })
  @Get('me/time-off')
  @RequirePermissions(PERMISSION.STAFF_READ_OWN)
  async findOwnTimeOff(@CurrentUser() user: AuthenticatedUser) {
    const tenantId = this.ctx.requireTenantId();
    const ownId = await this.staffScope.resolveOwnStaffId(tenantId, user.id);
    if (!ownId) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    return this.timeOff.list(tenantId, ownId);
  }

  @ApiOperation({
    summary: 'Get a staff member by ID',
    description: `
**Protected — requires \`staff.read\`. Clinic must be active.**

Returns the staff profile with its user and assigned services. A profile
from another clinic returns 404 (no cross-tenant leak).

**Who can call this:** Owner, Manager, Receptionist (\`staff.read\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Staff profile.', schema: S_STAFF })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.STAFF_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a staff profile',
    description: `
**Protected — requires \`staff.update\`. Clinic must be active.**

Updates mutable profile fields (title, bio, avatar, buffer, availability).
\`userId\` is immutable.

**Changing the role:** optionally pass \`roleSlug\` (and \`permissionSlugs\`
when it is the reserved value \`"other"\`) to reassign the linked account's
role — same validation and privilege-escalation guard as
\`POST /staff/from-new-user\`. Omit \`roleSlug\` entirely to leave the role
untouched. Requires \`staff.manage\` in addition to \`staff.update\`, and
refuses to touch an \`owner\`/\`super_admin\` account.

**Who can call this:** Owner, Manager (\`staff.update\`; \`staff.manage\` also
required to change the role).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Staff profile updated.', schema: S_STAFF })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `staff.update` (or `staff.manage` when changing the role), attempted a privileged role, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequirePermissions(PERMISSION.STAFF_UPDATE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentUser('permissions') callerPermissions: string[],
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.staff.update(
      this.ctx.requireTenantId(),
      id,
      dto,
      callerPermissions,
      actorUserId,
    );
  }

  @ApiOperation({
    summary: 'Activate a staff member (make bookable)',
    description: `
**Protected — requires \`staff.update\`. Clinic must be active.**

Sets \`is_available_for_booking = true\`. The staff member becomes visible
in availability lookups.

**Who can call this:** Owner, Manager (\`staff.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Staff activated.', schema: S_STAFF })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.STAFF_UPDATE)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.setAvailability(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({
    summary: 'Deactivate a staff member (hide from booking)',
    description: `
**Protected — requires \`staff.update\`. Clinic must be active.**

Sets \`is_available_for_booking = false\`. The record is preserved but the
staff member is excluded from availability/booking. Existing appointments
are unaffected.

**Who can call this:** Owner, Manager (\`staff.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Staff deactivated.', schema: S_STAFF })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.STAFF_UPDATE)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.setAvailability(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({
    summary: 'Delete a staff profile (soft)',
    description: `
**Protected — requires \`staff.manage\`. Clinic must be active.**

Soft-deletes the staff profile (sets \`deleted_at\`). Historical
appointments, commissions and ratings are retained.

**Who can call this:** Owner, Manager (\`staff.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Staff profile soft-deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.STAFF_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.remove(this.ctx.requireTenantId(), id);
  }

  // ────────────────────── Reception dashboard access ─────────────────────── //

  @ApiOperation({
    summary: 'Grant Reception Dashboard access to a staff member',
    description: `
**Protected — requires \`staff.manage\`. Clinic must be active.**

Gives an existing staff member access to the Reception Dashboard
(\`/reception/**\`) by setting their linked account's role to
\`receptionist\`.

**This does NOT create or link an account.** Every staff profile already
owns exactly one user account (\`staff_profiles.user_id\` is UNIQUE and is
always populated on creation), so this endpoint only changes the ROLE of
that existing account.

**The role is fixed server-side** to \`receptionist\` from the RBAC
catalogue — the request carries no role and no permissions, so this
endpoint can never be used to mint an owner, manager or platform admin.
Accounts holding a protected role (\`owner\`, \`super_admin\`) are rejected.

Side effects:
 - any other role on the account is REPLACED by \`receptionist\`
 - the account is re-enabled (\`is_active = true\`)
 - existing sessions/refresh tokens are revoked (the permission set changed)
 - if the person has never signed in, a single-use set-password invitation
   is emailed (same \`password_resets\` mechanism as forgot-password)

Idempotent: re-running for an already-active receptionist changes nothing
and will not sign them out or re-send an invitation.

**Who can call this:** Owner, Manager (\`staff.manage\`). Receptionists hold
only \`staff.read\` and therefore cannot grant access to themselves or anyone else.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Access granted; returns the new access state.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `staff.manage`, the target holds a protected role (`owner`/`super_admin`), or the clinic is inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description:
      "Staff member not found in this clinic (also returned for another clinic's id).",
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'The staff member has no email address.',
    schema: S_ERROR,
  })
  @Post(':id/dashboard-access')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.STAFF_MANAGE)
  grantDashboardAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.access.grant(this.ctx.requireTenantId(), id, actorId);
  }

  @ApiOperation({
    summary: "Disable a staff member's dashboard login access",
    description: `
**Protected — requires \`staff.manage\`. Clinic must be active.**

Sets \`users.is_active = false\` and revokes refresh tokens, so the account
can no longer sign in or call the API and live sessions end immediately.

**The staff record is NOT deleted.** Appointments, notes and every record
the person created are retained, and their booking availability
(\`is_available_for_booking\`) is a separate switch that is left untouched —
employment/bookability and login access are deliberately independent.

**Who can call this:** Owner, Manager (\`staff.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Access disabled; returns the new access state.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `staff.manage`, or the target holds a protected role.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'The staff member does not have dashboard access yet.',
    schema: S_ERROR,
  })
  @Post(':id/dashboard-access/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.STAFF_MANAGE)
  disableDashboardAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.access.setEnabled(
      this.ctx.requireTenantId(),
      id,
      false,
      actorId,
    );
  }

  @ApiOperation({
    summary: "Re-enable a staff member's dashboard login access",
    description: `
**Protected — requires \`staff.manage\`. Clinic must be active.**

Sets \`users.is_active = true\`, restoring the account's ability to sign in.
The receptionist role must already be present (grant access first).

**Who can call this:** Owner, Manager (\`staff.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Access enabled; returns the new access state.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `staff.manage`, or the target holds a protected role.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'The staff member does not have dashboard access yet.',
    schema: S_ERROR,
  })
  @Post(':id/dashboard-access/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.STAFF_MANAGE)
  enableDashboardAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.access.setEnabled(
      this.ctx.requireTenantId(),
      id,
      true,
      actorId,
    );
  }

  @ApiOperation({
    summary: 'Resend the dashboard set-password invitation',
    description: `
**Protected — requires \`staff.manage\`. Clinic must be active.**

Issues a fresh single-use set-password token and emails the invitation
again. Reuses the same \`password_resets\` table and
\`POST /auth/reset-password\` consumption path as forgot-password — there is
only one credential-setup mechanism in the system. The raw token is only
ever delivered by email; it is stored hashed and never logged or returned.

Only valid while the person has never signed in — once they have, they own
their password and should use forgot-password instead.

**Who can call this:** Owner, Manager (\`staff.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Invitation re-sent; returns the current access state.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `staff.manage`, or the target holds a protected role.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'No dashboard access yet, the staff member has already signed in, or they have no email address.',
    schema: S_ERROR,
  })
  @Post(':id/dashboard-access/resend-invitation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.STAFF_MANAGE)
  resendDashboardInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.access.resendInvitation(
      this.ctx.requireTenantId(),
      id,
      actorId,
    );
  }

  // ─────────────────────── Service / branch mapping ──────────────────────── //

  @ApiOperation({
    summary: 'Set the services a staff member can perform',
    description: `
**Protected — requires \`staff.update\`. Clinic must be active.**

Replaces the staff member's qualified-services set (idempotent). Each
service must belong to the clinic and be **active** — this is the
qualification business-rule hook (extend for licence/skill checks).

**Who can call this:** Owner, Manager (\`staff.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Services assigned; returns the updated profile.',
    schema: S_STAFF,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'A service is inactive, missing, or from another clinic.',
    schema: S_ERROR,
  })
  @Put(':id/services')
  @RequirePermissions(PERMISSION.STAFF_UPDATE)
  assignServices(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignServicesDto,
  ) {
    return this.staff.assignServices(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'List the services a staff member can perform',
    description: `**Protected — requires \`staff.read\`. Clinic must be active.** Returns the staff member's assigned services.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Assigned services.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id/services')
  @RequirePermissions(PERMISSION.STAFF_READ)
  listServices(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.listServices(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Assign a staff member to branches',
    description: `
**Protected — requires \`staff.update\`. Clinic must be active.**

Replaces the staff member's branch assignments (via \`branch_users\`). Each
branch must belong to the clinic. \`primaryBranchId\`, if provided, must be
one of \`branchIds\`.

**Who can call this:** Owner, Manager (\`staff.update\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Branch assignments updated.' })
  @ApiBadRequestResponse({
    description: 'primaryBranchId not in branchIds, or validation failed.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'A branch was not found in this clinic.',
    schema: S_ERROR,
  })
  @Put(':id/branches')
  @RequirePermissions(PERMISSION.STAFF_UPDATE)
  assignBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignBranchesDto,
  ) {
    return this.staff.assignBranches(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'List the branches a staff member is assigned to',
    description: `**Protected — requires \`staff.read\`. Clinic must be active.** Returns the staff member's branch assignments.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Branch assignments.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id/branches')
  @RequirePermissions(PERMISSION.STAFF_READ)
  listBranches(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.listBranches(this.ctx.requireTenantId(), id);
  }

  // ─────────────────────────── Schedules ─────────────────────────────────── //

  @ApiOperation({
    summary: 'Add a weekly schedule slot for a staff member',
    description: `
**Protected — requires \`staff.schedule.manage\`. Clinic must be active.**

Creates one recurring weekly availability slot (per branch, per weekday).
Multiple slots per day are allowed (split shifts). **Overlapping active
slots on the same day are rejected (409).**

**Validation:** \`endTime\` must be after \`startTime\`; times are 24h \`HH:MM\`;
\`dayOfWeek\` is 0–6.

**Who can call this:** Owner, Manager (\`staff.schedule.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({
    description: 'Schedule slot created.',
    schema: S_SCHEDULE,
  })
  @ApiBadRequestResponse({
    description: 'Validation failed or end ≤ start.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.schedule.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member or branch not found.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Slot overlaps an existing active slot that day.',
    schema: S_ERROR,
  })
  @Post(':id/schedules')
  @RequirePermissions(PERMISSION.STAFF_SCHEDULE_MANAGE)
  createSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateScheduleDto,
  ) {
    return this.schedules.createSchedule(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: "List a staff member's weekly schedule",
    description: `**Protected — requires \`staff.read\`. Clinic must be active.** Returns all schedule slots ordered by weekday then start time.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Schedule slots.',
    schema: { type: 'array', items: S_SCHEDULE },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id/schedules')
  @RequirePermissions(PERMISSION.STAFF_READ)
  listSchedules(@Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.listSchedules(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a schedule slot',
    description: `
**Protected — requires \`staff.schedule.manage\`. Clinic must be active.**

Partially updates a slot. The merged result is re-validated for time order
and (if active) overlap with the staff member's other slots that day.

**Who can call this:** Owner, Manager (\`staff.schedule.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'scheduleId',
    description: 'Schedule slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Schedule slot updated.', schema: S_SCHEDULE })
  @ApiBadRequestResponse({
    description: 'Validation failed or end ≤ start.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.schedule.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member, schedule, or branch not found.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Updated slot overlaps an existing active slot.',
    schema: S_ERROR,
  })
  @Patch(':id/schedules/:scheduleId')
  @RequirePermissions(PERMISSION.STAFF_SCHEDULE_MANAGE)
  updateSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() dto: UpdateScheduleDto,
  ) {
    return this.schedules.updateSchedule(
      this.ctx.requireTenantId(),
      id,
      scheduleId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Delete a schedule slot',
    description: `**Protected — requires \`staff.schedule.manage\`. Clinic must be active.** Permanently removes a recurring slot.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'scheduleId',
    description: 'Schedule slot UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Schedule slot deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.schedule.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member or schedule not found.',
    schema: S_ERROR,
  })
  @Delete(':id/schedules/:scheduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.STAFF_SCHEDULE_MANAGE)
  removeSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
  ) {
    return this.schedules.removeSchedule(
      this.ctx.requireTenantId(),
      id,
      scheduleId,
    );
  }

  // ─────────────────────────── Time off ──────────────────────────────────── //

  @ApiOperation({
    summary: 'Record time off for a staff member',
    description: `
**Protected — requires \`staff.timeoff.manage\`. Clinic must be active.**

Records a block of time off (vacation / sick leave / admin entry).

**⚠️ Schema note:** the finalized \`staff_time_off\` table has only
\`start_date / end_date / reason\` — there is **no status/approved_by column**.
Honoring the "do not change the schema" constraint, a created record is an
EFFECTIVE absence (it removes the staff from availability for those dates).
A pending→approved→rejected workflow would require a migration and is out
of scope; this endpoint therefore both "requests" and commits the leave.

**Validation:** \`endDate\` ≥ \`startDate\`.

**Who can call this:** Owner, Manager (\`staff.timeoff.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({ description: 'Time off recorded.', schema: S_TIME_OFF })
  @ApiBadRequestResponse({
    description: 'endDate before startDate, or validation failed.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.timeoff.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Post(':id/time-off')
  @RequirePermissions(PERMISSION.STAFF_TIMEOFF_MANAGE)
  createTimeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTimeOffDto,
  ) {
    return this.timeOff.create(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: "List a staff member's time off",
    description: `**Protected — requires \`staff.read\`. Clinic must be active.** Returns time-off records, most recent first.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Time-off records.',
    schema: { type: 'array', items: S_TIME_OFF },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id/time-off')
  @RequirePermissions(PERMISSION.STAFF_READ)
  listTimeOff(@Param('id', ParseUUIDPipe) id: string) {
    return this.timeOff.list(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Delete a time-off record',
    description: `**Protected — requires \`staff.timeoff.manage\`. Clinic must be active.** Removes a time-off block (e.g. a cancelled vacation).`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'timeOffId',
    description: 'Time-off record UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Time-off record deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.timeoff.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member or time-off record not found.',
    schema: S_ERROR,
  })
  @Delete(':id/time-off/:timeOffId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.STAFF_TIMEOFF_MANAGE)
  removeTimeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('timeOffId', ParseUUIDPipe) timeOffId: string,
  ) {
    return this.timeOff.remove(this.ctx.requireTenantId(), id, timeOffId);
  }

  // ─────────────────────────── Commissions ───────────────────────────────── //

  @ApiOperation({
    summary: 'Create a commission rule for a staff member',
    description: `
**Protected — requires \`staff.manage\`. Clinic must be active.**

Defines a commission rule (\`PERCENT\` of service price, or \`FIXED\` amount).
Optionally service-specific via \`serviceId\`; otherwise it is the staff
member's default rule.

**Who can call this:** Owner, Manager (\`staff.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({
    description: 'Commission rule created.',
    schema: S_COMMISSION,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Post(':id/commissions')
  @RequirePermissions(PERMISSION.STAFF_MANAGE)
  createCommission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommissionDto,
  ) {
    return this.commissions.create(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: "List a staff member's commission rules",
    description: `**Protected — requires \`staff.commission.read\`. Clinic must be active.** Returns the configured commission rules.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Commission rules.',
    schema: { type: 'array', items: S_COMMISSION },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.commission.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id/commissions')
  @RequirePermissions(PERMISSION.STAFF_COMMISSION_READ)
  listCommissions(@Param('id', ParseUUIDPipe) id: string) {
    return this.commissions.list(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: "Get a staff member's commission summary (report)",
    description: `
**Protected — requires \`staff.commission.read\`. Clinic must be active.**

Computes earned commission over a date range by walking the staff member's
**completed** appointments and applying the matching rule (service-specific,
falling back to the default). Returns totals + a per-service breakdown.
Defaults to the current month when \`from\`/\`to\` are omitted.

**Who can call this:** Owner, Manager (\`staff.commission.read\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Aggregated commission report.',
    schema: S_COMMISSION_SUMMARY,
  })
  @ApiBadRequestResponse({
    description: 'Invalid date range.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.commission.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id/commissions/summary')
  @RequirePermissions(PERMISSION.STAFF_COMMISSION_READ)
  commissionSummary(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CommissionSummaryQueryDto,
  ) {
    return this.commissions.summary(this.ctx.requireTenantId(), id, query);
  }

  // ───────────────────────────── Ratings ─────────────────────────────────── //

  @ApiOperation({
    summary: 'Record a rating for a staff member',
    description: `
**Protected — requires \`staff.manage\`. Clinic must be active.**

Records a 1–5 rating tied to a **completed** appointment that was handled by
this staff member. The customer is derived from the appointment.

**Business rules / failures**
- Appointment must exist in the clinic (404).
- Appointment must belong to this staff member (422).
- Appointment must be \`COMPLETED\` (422).
- One rating per (staff, appointment) — duplicates rejected (409).

**Who can call this:** Owner, Manager, or system feedback jobs (\`staff.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({ description: 'Rating recorded.' })
  @ApiBadRequestResponse({
    description: 'Validation failed (rating 1–5).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member or appointment not found.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'This appointment was already rated for this staff member.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Appointment is not completed or not handled by this staff member.',
    schema: S_ERROR,
  })
  @Post(':id/ratings')
  @RequirePermissions(PERMISSION.STAFF_MANAGE)
  createRating(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateStaffRatingDto,
  ) {
    return this.ratings.create(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: "Get a staff member's ratings (with average)",
    description: `**Protected — requires \`staff.rating.read\`. Clinic must be active.** Returns the rating list plus count and average.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Staff profile UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Ratings with aggregate.',
    schema: S_RATING_LIST,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `staff.rating.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Staff member not found.',
    schema: S_ERROR,
  })
  @Get(':id/ratings')
  @RequirePermissions(PERMISSION.STAFF_RATING_READ)
  listRatings(@Param('id', ParseUUIDPipe) id: string) {
    return this.ratings.list(this.ctx.requireTenantId(), id);
  }
}

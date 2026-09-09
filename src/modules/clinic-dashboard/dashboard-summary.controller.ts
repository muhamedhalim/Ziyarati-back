import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { PrivateCache } from '../../common/http/private-cache.decorator';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

import {
  DashboardSummaryService,
  type DashboardSummary,
} from './dashboard-summary.service';

const S_SUMMARY = {
  type: 'object',
  properties: {
    appointments: { type: 'number', nullable: true, example: 128 },
    myPatients: { type: 'number', nullable: true, example: 37 },
    customers: { type: 'number', nullable: true, example: 412 },
    staff: { type: 'number', nullable: true, example: 9 },
    pendingHandovers: { type: 'number', nullable: true, example: 2 },
    scope: {
      type: 'object',
      properties: {
        appointments: { type: 'string', enum: ['ALL', 'OWN', 'NONE'] },
      },
    },
    generatedAt: { type: 'string', format: 'date-time' },
  },
};

/**
 * How long a browser may reuse this response without asking again.
 *
 * Matched to `ANALYTICS_CACHE_TTL` (60 s default) so the two layers agree: a
 * request the browser does send within that window can only ever be answered
 * from the server-side cache anyway, so letting the browser skip it entirely
 * costs no additional staleness — it just removes a round trip.
 *
 * `private` is load-bearing: this is per-tenant, per-permission data and must
 * never be stored by a shared proxy. `must-revalidate` forbids serving it
 * stale past `max-age` if the network is unavailable.
 */
const SUMMARY_MAX_AGE_SECONDS = 30;

/**
 * The clinic/reception dashboard's KPI row, in one request.
 *
 * ── WHY THIS IS ITS OWN CONTROLLER AND NOT PART OF `analytics/dashboard` ────
 * `DashboardController` (`GET /analytics/dashboard`) carries
 * `@RequireFeature(FeatureKey.ANALYTICS)`, `@RequireActiveSubscription()` and
 * `@RequirePermissions(analytics.dashboard.read)`. These four counts are not
 * analytics — they are the same numbers the appointments, customers, staff and
 * handover LIST endpoints already expose, and a clinic without the analytics
 * capability sees them today. Mounting them there would silently take the KPI
 * row away from those tenants, which is a product regression dressed up as a
 * performance fix.
 *
 * So: same guard posture as the resource endpoints it replaces
 * (`ActiveTenantGuard`, plus the global `JwtAuthGuard`), and per-metric
 * permission resolution inside the service — see its docstring.
 *
 * `PermissionsGuard` is deliberately NOT applied: there is no single
 * permission that admits this route. The route admits any authenticated
 * tenant user and returns `null` for every count they cannot read, which is
 * exactly the shape the dashboard already handles (a 403 from a list endpoint
 * rendered a muted dash).
 *
 * ── ENTITLEMENT ─────────────────────────────────────────────────────────────
 * The dashboard shell belongs to `core.workspace`, which the registry declares
 * `alwaysOn` — so `@RequireFeature(FeatureKey.CORE_WORKSPACE)` would be a gate
 * that can never close. The typed `@NoEntitlementRequired` records WHICH
 * always-on capability this is, the same way `ActivityLogController` does, so
 * "ungated" stays a checked decision rather than an omission.
 *
 * Note this is metadata only — no guard reads it — and it does NOT weaken the
 * per-metric gating above. The AI capability is still resolved at runtime
 * before the handover count is included; see the service.
 */
@ApiTags('Clinic Dashboard')
@ApiBearerAuth('JWT-auth')
@Controller('dashboard')
@UseGuards(ActiveTenantGuard)
@NoEntitlementRequired(FeatureKey.CORE_WORKSPACE)
export class DashboardSummaryController {
  constructor(
    private readonly summary: DashboardSummaryService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary:
      'Dashboard KPI counts (appointments, patients, customers, staff, pending handovers)',
    description: `
**Protected — authenticated tenant user, clinic active.**

Replaces four \`?limit=1\` list calls with one request and one SQL statement.

Each count is returned ONLY if the caller holds the permission its list
endpoint requires (\`appointments.read\`/\`appointments.read_own\`,
\`crm.customers.read\`, \`staff.read\`, \`ai.handover.read\` + the tenant's
\`ai\` capability). A count the caller may not read comes back \`null\`, never
\`0\` — the two mean different things and the UI renders them differently.

A caller holding only \`appointments.read_own\` gets the count of their OWN
appointments; the scope actually applied is echoed in \`scope.appointments\`.

\`myPatients\` is a DIFFERENT question from \`customers\`: it is the count of
DISTINCT customers across the appointments this caller may read (the same
own-staff + branch scope as \`appointments\`), never the clinic-wide customer
list — for a doctor this is genuinely "how many of my patients"; for a
tenant-wide caller it is still narrower than \`customers\` ("patients with at
least one appointment" vs. "every customer record").

Served through the per-tenant analytics cache, so repeat opens inside the TTL
do not reach the database at all.`.trim(),
  })
  @ApiOkResponse({ description: 'Dashboard KPI counts.', schema: S_SUMMARY })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
  @ApiForbiddenResponse({ description: 'Clinic inactive.' })
  @Get('summary')
  @PrivateCache(SUMMARY_MAX_AGE_SECONDS)
  get(@CurrentUser() user: AuthenticatedUser): Promise<DashboardSummary> {
    return this.summary.get(this.ctx.requireTenantId(), user);
  }
}

import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';

import { ClinicSupportProfileService } from './clinic-support-profile.service';
import { SupportClinicDirectoryService } from './support-clinic-directory.service';
import { SupportEntitlementService } from './support-entitlement.service';
import { SupportIntegrationService } from './support-integration.service';
import { SupportDeliveryService } from './support-delivery.service';
import { SupportActivityService } from './support-activity.service';
import { SupportBookingService } from './support-booking.service';
import { SupportAiService } from './support-ai.service';
import {
  QuerySupportDeliveryDto,
  QuerySupportDiagnosticsDto,
} from './dto/query-support-diagnostics.dto';
import { QuerySupportClinicsDto } from './dto/query-support-clinics.dto';

/**
 * ============================================================================
 *  SUPPORT OPERATIONS CONSOLE — clinic diagnostics
 * ============================================================================
 *
 * Dedicated, sanitized, READ-ONLY endpoints for Platform Customer Service.
 *
 * WHY DEDICATED ENDPOINTS RATHER THAN WIDENING SUPER ADMIN ROUTES. Every
 * Super Admin diagnostic route in this codebase returns more than Support
 * needs — plan catalogues, platform cost, tenant verification documents, raw
 * provider payloads. Admitting `platform_support` to one of those would grant
 * all of it. Instead each route here composes the same authoritative service
 * the rest of the platform uses and projects an explicit allow-list.
 *
 * CROSS-TENANT BY DESIGN, EXPLICIT BY REQUIREMENT. Support is intentionally
 * cross-tenant, so the target clinic is always an explicit `:tenantId` path
 * parameter, validated by `SupportClinicResolver` (404 for an unknown or
 * soft-deleted clinic). No tenant-scoped service was made tenant-optional,
 * `TenantContextService.requireTenantId()` is untouched, and no tenant route
 * admits a platform principal — a Support agent supplying another tenantId to
 * a TENANT api still gets 403 from `requireTenantId()`, exactly as before.
 *
 * PERMISSIONS ARE PER-ROUTE, never per-controller: a class-level grant would
 * make the whole console one permission, which is precisely the broad
 * `platform.support.manage` slug the brief forbids. `super_admin` continues to
 * reach every route through the `'*'` wildcard, unchanged.
 */
@ApiTags('Platform Support — Clinic Diagnostics')
@ApiBearerAuth('JWT-auth')
@Controller('platform/support/clinics')
@UseGuards(PermissionsGuard)
export class PlatformSupportClinicController {
  constructor(
    private readonly directory: SupportClinicDirectoryService,
    private readonly profiles: ClinicSupportProfileService,
    private readonly entitlements: SupportEntitlementService,
    private readonly integrations: SupportIntegrationService,
    private readonly delivery: SupportDeliveryService,
    private readonly activity: SupportActivityService,
    private readonly bookings: SupportBookingService,
    private readonly aiDiagnostics: SupportAiService,
  ) {}

  @ApiOperation({
    summary: 'Clinic directory (Support)',
    description:
      'Paginated, searchable clinic directory — the PROACTIVE entry point, so a support agent can ' +
      'find the clinic that phoned them without a ticket existing first. Search matches name, slug, ' +
      'clinic contact email and clinic contact phone. Each row carries operational state only: ' +
      'active/approval state, plan IDENTITY, branch counts, open-ticket count and last support ' +
      'activity. This is NOT the Super Admin tenant directory: verification documents, commercial ' +
      'registration, legal identity, plan pricing and the approve/reject/suspend controls are ' +
      'absent, and no field of `tenants` outside the projection is selected.',
  })
  @ApiOkResponse({ description: 'Paginated, allow-listed clinic directory.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_CLINICS_READ_BASIC)
  @Get()
  clinics(@Query() query: QuerySupportClinicsDto) {
    return this.directory.list(query);
  }

  @ApiOperation({
    summary: 'Clinic support profile',
    description:
      'Operational identity and structure only — name, slug, status, timezone, contact, branches ' +
      'and active staff/service counts. Never the full Tenant entity, never verification documents, ' +
      'credentials or private financial configuration.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Allow-listed clinic profile.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_CLINICS_READ_BASIC)
  @Get(':tenantId')
  profile(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.profiles.profile(tenantId);
  }

  @ApiOperation({
    summary: 'Subscription diagnostics',
    description:
      'Answers "is access blocked, and by what?" — effective status, access source (subscription / ' +
      'free override / platform free mode), plan identity, expiry, quota enforcement and usage vs. ' +
      'limits. Excludes internal platform cost, margins and pricing configuration. Read-only: ' +
      'Platform Support holds no slug that can change a plan, extend a subscription or alter usage.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Subscription state and usage summary.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_SUBSCRIPTIONS_READ)
  @Get(':tenantId/subscription')
  subscription(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.entitlements.subscription(tenantId);
  }

  @ApiOperation({
    summary: 'Feature / module availability diagnostics',
    description:
      'Per feature: platform default vs. clinic override, plan inclusion, dependency satisfaction, ' +
      "usage against quota, and the resolver's own availability verdict with a machine-readable " +
      "blockedReason. Composed from FeatureResolverService — the platform's single effective- " +
      'feature resolver — so Support always sees exactly what the guards enforce.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Per-feature availability matrix.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_FEATURES_READ)
  @Get(':tenantId/features')
  features(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.entitlements.featureMatrix(tenantId);
  }

  @ApiOperation({
    summary: 'Safe clinic configuration diagnostics',
    description:
      'The operational settings that explain observed behaviour — booking confirmation mode, ' +
      'payment requirement, cancellation window, language, bot and public-booking toggles — plus a ' +
      'derived booking-readiness checklist. A mapped subset, never the settings row itself.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Allow-listed configuration + readiness.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_CLINIC_SETTINGS_READ)
  @Get(':tenantId/configuration')
  configuration(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.profiles.configuration(tenantId);
  }

  @ApiOperation({
    summary: 'Unified integration status',
    description:
      'WhatsApp / email / payments / AI / storage in one view: configured vs. connected vs. ' +
      'degraded vs. disconnected, webhook liveness, last inbound/outbound/failure timestamps and a ' +
      'sanitized latest failure reason. Credentials are never selected — where the PRESENCE of a ' +
      'token matters it is derived in SQL as a boolean and the value never leaves the database.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Per-integration status, no credentials.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_READ)
  @Get(':tenantId/integrations')
  integrationStatus(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.integrations.overview(tenantId);
  }

  @ApiOperation({
    summary: 'Email delivery history',
    description:
      'Paginated, date-bounded history from email_logs: template, masked recipient, status, ' +
      'provider, provider message id, attempts, sanitized failure reason and timestamps. No message ' +
      'body is stored by the platform and none is returned.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Paginated email delivery attempts.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_READ)
  @Get(':tenantId/emails')
  emails(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: QuerySupportDeliveryDto,
  ) {
    return this.delivery.emails(tenantId, query);
  }

  @ApiOperation({
    summary: 'Notification delivery history',
    description:
      'Paginated, date-bounded history from notification_logs across WhatsApp / SMS / push / ' +
      'in-app. SEND_UNCERTAIN is surfaced verbatim rather than folded into FAILED — it means a ' +
      'worker crashed after the send attempt, so delivery is genuinely unknown. Recipients appear ' +
      'as opaque ids only.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Paginated notification delivery attempts.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_READ)
  @Get(':tenantId/notifications')
  notifications(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: QuerySupportDeliveryDto,
  ) {
    return this.delivery.notifications(tenantId, query);
  }

  @ApiOperation({
    summary: 'Sanitized operational activity timeline',
    description:
      'Allow-listed operational audit events for the clinic — action, actor, timestamp and the ' +
      'NAMES of the fields that changed. Raw old_values/new_values JSONB is never returned, and an ' +
      'action absent from the allow-list does not appear at all.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Paginated sanitized activity events.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_AUDIT_READ)
  @Get(':tenantId/activity')
  activityTimeline(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: QuerySupportDiagnosticsDto,
  ) {
    return this.activity.timeline(tenantId, query);
  }

  @ApiOperation({
    summary: 'Appointment diagnostics',
    description:
      'Diagnostic projection only — scheduling status, payment status, source (Manual / WhatsApp / ' +
      'Public AI / Platform), branch, timing, and whether a payment link or successful payment ' +
      'exists. Patient identity is MASKED. No clinical or booking notes, no medical history, no ' +
      'chronic conditions, no patient files, and no insurance detail beyond the payment ' +
      'classification are queried or returned. Platform Support holds no appointments.* or crm.* ' +
      'permission and cannot reach those APIs at all.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Paginated appointment diagnostics.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_APPOINTMENTS_READ_DIAGNOSTICS)
  @Get(':tenantId/appointments')
  appointments(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: QuerySupportDiagnosticsDto,
  ) {
    return this.bookings.appointments(tenantId, query);
  }

  @ApiOperation({
    summary: 'One appointment, with its status timeline',
    description:
      'The same masked projection plus the status-change timeline and booked service names. An id ' +
      'belonging to a different clinic returns 404 — the tenant filter is part of the lookup, not a ' +
      'check applied afterwards.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'appointmentId',
    description: 'Appointment UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Appointment diagnostic detail.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_APPOINTMENTS_READ_DIAGNOSTICS)
  @Get(':tenantId/appointments/:appointmentId')
  appointment(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
  ) {
    return this.bookings.appointment(tenantId, appointmentId);
  }

  @ApiOperation({
    summary: 'Payment diagnostics',
    description:
      'Strict read-only projection: status, gateway, amount charged to the patient, currency, ' +
      'instrument class, sanitized failure reason, whether a gateway callback was ever processed, ' +
      'and the latest payment-link state. Excludes card data and tokens (never stored), gateway ' +
      "credentials, raw signed webhook payloads, and the platform's own economics (gateway_fee, " +
      'platform_fee, net_amount, settlement_status). No financial write permission exists: Support ' +
      'cannot mark paid, refund, capture, void or change an amount.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Paginated payment diagnostics.' })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_PAYMENTS_READ_DIAGNOSTICS)
  @Get(':tenantId/payments')
  payments(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: QuerySupportDiagnosticsDto,
  ) {
    return this.bookings.payments(tenantId, query);
  }

  @ApiOperation({
    summary: 'AI diagnostics',
    description:
      'Tool-call ledger (name, status, sanitized failure reason, linked appointment), conversation ' +
      'activity by channel and state, and handover state. Excludes AI provider keys, internal ' +
      'platform cost and token spend, system prompts, RAG content, session state and the ' +
      'conversation transcript. Strictly read-only — there is no endpoint to re-run a transactional ' +
      'tool call such as book / cancel / reschedule.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'AI tool-call, conversation and handover diagnostics.',
  })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_AI_READ_DIAGNOSTICS)
  @Get(':tenantId/ai')
  ai(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: QuerySupportDiagnosticsDto,
  ) {
    return this.aiDiagnostics.diagnostics(tenantId, query);
  }

  @ApiOperation({
    summary: 'WhatsApp diagnostics',
    description:
      'Focused view for "WhatsApp messages stopped working": connection state, display number, ' +
      'WABA identity, webhook health with last inbound/processed timestamps, recent sanitized ' +
      "failure reasons, and template approval counts. Gated by its own permission — a clinic's " +
      'messaging state is more sensitive than the integrations roll-up. The Meta access token, app ' +
      'secret, verification secret and webhook payloads are never returned. No configuration ' +
      'mutation exists on this surface.',
  })
  @ApiParam({
    name: 'tenantId',
    description: 'Clinic UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'WhatsApp connection, webhook, traffic and template state.',
  })
  @RequirePermissions(PERMISSION.PLATFORM_SUPPORT_WHATSAPP_READ_DIAGNOSTICS)
  @Get(':tenantId/whatsapp')
  whatsapp(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.integrations.whatsappDiagnostics(tenantId);
  }
}

import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { PublicDiscoveryService } from './public-discovery.service';
import { Public } from '../auth/decorators/public.decorator';
import {
  PUBLIC_DISCOVERY_CITIES_THROTTLE,
  PUBLIC_DISCOVERY_CLINICS_THROTTLE,
  PUBLIC_DISCOVERY_CLINIC_DETAIL_THROTTLE,
  PUBLIC_DISCOVERY_MARKETPLACE_CLINIC_THROTTLE,
} from './public-discovery.throttle';

/**
 * Public clinic discovery — ANONYMOUS (bypasses the global JwtAuthGuard via
 * `@Public`). Read-only public marketing data for the website AI chat widget's
 * discovery flow (find clinic → branches → doctors → services). No private data.
 */
@ApiTags('Public Discovery')
@Controller('public/discovery')
export class PublicDiscoveryController {
  constructor(private readonly discovery: PublicDiscoveryService) {}

  @Public()
  @ApiOperation({
    summary: 'List cities that have bookable clinics',
    description:
      'The first step of the public booking flow. Derived from live branches of APPROVED, active, publicly-bookable clinics, so a city is never offered with nothing behind it.',
  })
  @ApiOkResponse({ description: 'Cities with at least one bookable branch.' })
  @Throttle(PUBLIC_DISCOVERY_CITIES_THROTTLE)
  @Get('cities')
  cities() {
    return this.discovery.listCities();
  }

  @Public()
  @ApiOperation({
    summary: 'Search public clinics by name or offered service',
    description:
      'Backward compatible (contract C1): when page/pageSize are both absent, returns the ' +
      'original bare array capped at 24 — the shape the shipped chat widget depends on. ' +
      'Passing page/pageSize opts into the {items,total,page,pageSize} envelope instead.',
  })
  @ApiQuery({ name: 'q', required: false, example: 'dentist' })
  @ApiQuery({
    name: 'cityId',
    required: false,
    format: 'uuid',
    description:
      'Narrow to clinics with at least one active branch in this city.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({
    description:
      'Matching public clinics (cards) — a bare array by default, or a paginated envelope when page/pageSize are supplied.',
  })
  @Throttle(PUBLIC_DISCOVERY_CLINICS_THROTTLE)
  @Get('clinics')
  clinics(
    @Query('q') q?: string,
    @Query('cityId') cityId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    // Presence, not just parseability, decides the response shape (C1's
    // mandatory backward-compat rule) — an absent param must never be coerced
    // into "page 1", which would silently switch every existing caller onto
    // the new envelope.
    if (page === undefined && pageSize === undefined) {
      return this.discovery.searchClinics(q, undefined, cityId);
    }
    const parsedPage = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const parsedPageSize = Math.min(Math.max(1, parseInt(pageSize ?? '24', 10) || 24), 24);
    return this.discovery.searchClinics(q, undefined, cityId, {
      page: parsedPage,
      pageSize: parsedPageSize,
    });
  }

  @Public()
  @ApiOperation({
    summary: 'Public clinic detail: branches, services, doctors',
    description:
      'Contract C2a: `id` may be a UUID or a clinic slug. Resolution is unambiguous ' +
      '(tenants.slug is unique and cannot collide with the UUID format). An identifier ' +
      'that resolves to nothing — malformed, unknown, or de-listed — 404s identically.',
  })
  @ApiOkResponse({ description: 'Clinic public detail for the booking flow.' })
  @Throttle(PUBLIC_DISCOVERY_CLINIC_DETAIL_THROTTLE)
  @Get('clinics/:id')
  clinic(@Param('id') id: string) {
    return this.discovery.clinicDetail(id);
  }

  @Public()
  @ApiOperation({
    summary: 'Marketplace clinic projection: branches, services (per-branch priced), doctors',
    description:
      'Contract C2b — a SEPARATE, Marketplace-only projection. Never edits the frozen ' +
      'clinicDetail()/searchClinics() the AI calls in-process (P3). Every collection is ' +
      'paginated with an explicit total (P7); no silent truncation.',
  })
  @ApiOkResponse({ description: 'Enriched clinic detail for the Marketplace.' })
  @Throttle(PUBLIC_DISCOVERY_MARKETPLACE_CLINIC_THROTTLE)
  @Get('marketplace/clinics/:idOrSlug')
  marketplaceClinic(
    @Param('idOrSlug') idOrSlug: string,
    @Query('branchesPage') branchesPage?: string,
    @Query('branchesPageSize') branchesPageSize?: string,
    @Query('servicesPage') servicesPage?: string,
    @Query('servicesPageSize') servicesPageSize?: string,
    @Query('doctorsPage') doctorsPage?: string,
    @Query('doctorsPageSize') doctorsPageSize?: string,
  ) {
    const toInt = (v: string | undefined) => (v === undefined ? undefined : parseInt(v, 10) || undefined);
    return this.discovery.marketplaceClinicDetail(idOrSlug, {
      branchesPage: toInt(branchesPage),
      branchesPageSize: toInt(branchesPageSize),
      servicesPage: toInt(servicesPage),
      servicesPageSize: toInt(servicesPageSize),
      doctorsPage: toInt(doctorsPage),
      doctorsPageSize: toInt(doctorsPageSize),
    });
  }
}

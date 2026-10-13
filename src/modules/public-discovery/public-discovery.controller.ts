import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { PublicDiscoveryService } from './public-discovery.service';
import { StorageService } from '../storage/storage.service';
import { Public } from '../auth/decorators/public.decorator';
import { AppError, ErrorCode } from '../../common/errors';
import {
  PUBLIC_DISCOVERY_CITIES_THROTTLE,
  PUBLIC_DISCOVERY_CLINICS_THROTTLE,
  PUBLIC_DISCOVERY_CLINIC_DETAIL_THROTTLE,
  PUBLIC_DISCOVERY_MARKETPLACE_CLINIC_THROTTLE,
  PUBLIC_DISCOVERY_CATEGORIES_THROTTLE,
  PUBLIC_DISCOVERY_SPECIALTIES_THROTTLE,
  PUBLIC_DISCOVERY_SPECIALTY_DETAIL_THROTTLE,
  PUBLIC_DISCOVERY_DOCTORS_THROTTLE,
  PUBLIC_DISCOVERY_DOCTOR_DETAIL_THROTTLE,
  PUBLIC_DISCOVERY_DOCTOR_AVATAR_THROTTLE,
  PUBLIC_DISCOVERY_SERVICES_THROTTLE,
  PUBLIC_DISCOVERY_SERVICE_DETAIL_THROTTLE,
} from './public-discovery.throttle';

/**
 * Public clinic discovery — ANONYMOUS (bypasses the global JwtAuthGuard via
 * `@Public`). Read-only public marketing data for the website AI chat widget's
 * discovery flow (find clinic → branches → doctors → services). No private data.
 */
@ApiTags('Public Discovery')
@Controller('public/discovery')
export class PublicDiscoveryController {
  constructor(
    private readonly discovery: PublicDiscoveryService,
    private readonly storage: StorageService,
  ) {}

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
    const parsedPageSize = Math.min(
      Math.max(1, parseInt(pageSize ?? '24', 10) || 24),
      24,
    );
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
    summary:
      'Marketplace clinic projection: branches, services (per-branch priced), doctors',
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
    const toInt = (v: string | undefined) =>
      v === undefined ? undefined : parseInt(v, 10) || undefined;
    return this.discovery.marketplaceClinicDetail(idOrSlug, {
      branchesPage: toInt(branchesPage),
      branchesPageSize: toInt(branchesPageSize),
      servicesPage: toInt(servicesPage),
      servicesPageSize: toInt(servicesPageSize),
      doctorsPage: toInt(doctorsPage),
      doctorsPageSize: toInt(doctorsPageSize),
    });
  }

  @Public()
  @ApiOperation({
    summary: 'List specialties with at least one eligible clinic',
    description:
      'Contract C3. Names are returned as both nameAr/nameEn (P5) — the client selects; no ' +
      'Accept-Language negotiation. A specialty with zero eligible clinics is absent, not empty.',
  })
  @ApiOkResponse({
    description: 'Specialties with at least one publicly bookable clinic.',
  })
  @Throttle(PUBLIC_DISCOVERY_SPECIALTIES_THROTTLE)
  @Get('specialties')
  specialties() {
    return this.discovery.listSpecialties();
  }

  @Public()
  @ApiOperation({
    summary:
      'List clinic-managed service categories that have bookable services',
    description:
      'Contract C13. The categories clinics manage in the dashboard (Services → Categories), ' +
      'folded across clinics by name. A category appears only while its clinic is eligible, it ' +
      'is active and not deleted, and it holds at least one active service offered at an active ' +
      'branch. `name` is the clinic-entered wording (no Arabic/English pair exists for categories); ' +
      '`slug` is derived from it. Capped, busiest first. Use `slug` as `categorySlug` on the ' +
      'services search.',
  })
  @ApiOkResponse({
    description:
      'Categories with `{ slug, name, clinicCount, serviceCount, services[] }`.',
  })
  @Throttle(PUBLIC_DISCOVERY_CATEGORIES_THROTTLE)
  @Get('categories')
  categories() {
    return this.discovery.listCategories();
  }

  @Public()
  @ApiOperation({
    summary:
      'Specialty detail: clinics and doctors, city-filterable, paginated',
    description:
      'Contract C4. An unknown slug 404s. A slug that exists but currently has zero eligible ' +
      'clinics returns 200 with empty collections instead — a 404 there would be ' +
      'indistinguishable from a bad slug.',
  })
  @ApiQuery({ name: 'cityId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'clinicsPage', required: false, type: Number })
  @ApiQuery({ name: 'clinicsPageSize', required: false, type: Number })
  @ApiQuery({ name: 'doctorsPage', required: false, type: Number })
  @ApiQuery({ name: 'doctorsPageSize', required: false, type: Number })
  @ApiOkResponse({
    description: 'Specialty detail with paginated clinics and doctors.',
  })
  @Throttle(PUBLIC_DISCOVERY_SPECIALTY_DETAIL_THROTTLE)
  @Get('specialties/:slug')
  specialtyDetail(
    @Param('slug') slug: string,
    @Query('cityId') cityId?: string,
    @Query('clinicsPage') clinicsPage?: string,
    @Query('clinicsPageSize') clinicsPageSize?: string,
    @Query('doctorsPage') doctorsPage?: string,
    @Query('doctorsPageSize') doctorsPageSize?: string,
  ) {
    const toInt = (v: string | undefined) =>
      v === undefined ? undefined : parseInt(v, 10) || undefined;
    return this.discovery.specialtyDetail(slug, {
      cityId,
      clinicsPage: toInt(clinicsPage),
      clinicsPageSize: toInt(clinicsPageSize),
      doctorsPage: toInt(doctorsPage),
      doctorsPageSize: toInt(doctorsPageSize),
    });
  }

  @Public()
  @ApiOperation({
    summary: 'Search doctors across clinics',
    description:
      'Contract C5. Only staff of eligible clinics, available-for-booking, not soft-deleted. ' +
      '`avatarUrl` is always the C12 proxy URL, never a signed storage URL, and is present only ' +
      'when the doctor actually has a stored avatar.',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cityId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'specialtySlug', required: false })
  @ApiQuery({ name: 'clinicSlug', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ description: 'Matching doctors, paginated.' })
  @Throttle(PUBLIC_DISCOVERY_DOCTORS_THROTTLE)
  @Get('doctors')
  doctors(
    @Query('q') q?: string,
    @Query('cityId') cityId?: string,
    @Query('specialtySlug') specialtySlug?: string,
    @Query('clinicSlug') clinicSlug?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const toInt = (v: string | undefined) =>
      v === undefined ? undefined : parseInt(v, 10) || undefined;
    return this.discovery.searchDoctors({
      q,
      cityId,
      specialtySlug,
      clinicSlug,
      page: toInt(page),
      pageSize: toInt(pageSize),
    });
  }

  @Public()
  @ApiOperation({
    summary: 'Doctor detail by slug',
    description:
      "Contract C6. `branches` feeds FR-083's context-depth decision. `avatarUrl` is always the " +
      'C12 proxy URL. Never exposed: user email/phone, schedules, booking_buffer_minutes, ' +
      'commissions, internal ratings, or any presigned storage URL.',
  })
  @ApiOkResponse({ description: 'Doctor detail.' })
  @Throttle(PUBLIC_DISCOVERY_DOCTOR_DETAIL_THROTTLE)
  @Get('doctors/:slug')
  doctorDetail(@Param('slug') slug: string) {
    return this.discovery.doctorDetail(slug);
  }

  @Public()
  @ApiOperation({
    summary: "A doctor's avatar image",
    description:
      'Contract C12. STREAMS the private R2 object — never a redirect, never the presigned URL ' +
      '(that would hand the private bucket URL to the browser/CDN). Eligibility (clinic ' +
      'APPROVED/active/opted-in, doctor available-for-booking) is re-checked on every request. ' +
      'An ineligible doctor, an unknown slug, and a doctor with no stored avatar are all the ' +
      'SAME 404 — never distinguishable from one another.',
  })
  @Throttle(PUBLIC_DISCOVERY_DOCTOR_AVATAR_THROTTLE)
  @Get('doctors/:slug/avatar')
  async doctorAvatar(
    @Param('slug') slug: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const source = await this.discovery.resolveDoctorAvatarSource(slug);
    if (!source) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Doctor not found' });
    }
    const { body, contentType, contentLength, etag } =
      await this.storage.getObjectStream(source.storageKey, source.tenantId);
    res.status(200);
    res.setHeader('Content-Type', contentType);
    if (contentLength !== undefined)
      res.setHeader('Content-Length', String(contentLength));
    if (etag) res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    (body as import('stream').Readable).pipe(res);
  }

  @Public()
  @ApiOperation({
    summary: 'Search services across clinics',
    description:
      'Contract C7. Honours the branch-scoped pricing rule (D1): one row per offering ' +
      '(service × branch), so a price is never shown detached from the branch it belongs to.',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cityId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'specialtySlug', required: false })
  @ApiQuery({
    name: 'categorySlug',
    required: false,
    description:
      'A `slug` from GET /public/discovery/categories (clinic-managed service category). ' +
      'A slug that matches no eligible category returns an empty page.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ description: 'Matching service offerings, paginated.' })
  @Throttle(PUBLIC_DISCOVERY_SERVICES_THROTTLE)
  @Get('services')
  services(
    @Query('q') q?: string,
    @Query('cityId') cityId?: string,
    @Query('specialtySlug') specialtySlug?: string,
    @Query('categorySlug') categorySlug?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const toInt = (v: string | undefined) =>
      v === undefined ? undefined : parseInt(v, 10) || undefined;
    return this.discovery.searchServices({
      q,
      cityId,
      specialtySlug,
      categorySlug,
      page: toInt(page),
      pageSize: toInt(pageSize),
    });
  }

  @Public()
  @ApiOperation({
    summary: 'Service detail, clinic-scoped',
    description:
      'Contract C8. A service belongs to exactly one clinic. `offerings` applies the same ' +
      'branch-scoped pricing rule as the search endpoint. `doctors` comes from the existing ' +
      'staff_services link, filtered to bookable staff.',
  })
  @ApiOkResponse({ description: 'Service detail.' })
  @Throttle(PUBLIC_DISCOVERY_SERVICE_DETAIL_THROTTLE)
  @Get('clinics/:clinicSlug/services/:serviceSlug')
  serviceDetail(
    @Param('clinicSlug') clinicSlug: string,
    @Param('serviceSlug') serviceSlug: string,
  ) {
    return this.discovery.serviceDetail(clinicSlug, serviceSlug);
  }
}

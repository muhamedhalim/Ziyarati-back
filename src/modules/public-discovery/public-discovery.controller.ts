import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { PublicDiscoveryService } from './public-discovery.service';
import { Public } from '../auth/decorators/public.decorator';

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
  @Get('cities')
  cities() {
    return this.discovery.listCities();
  }

  @Public()
  @ApiOperation({ summary: 'Search public clinics by name or offered service' })
  @ApiQuery({ name: 'q', required: false, example: 'dentist' })
  @ApiQuery({
    name: 'cityId',
    required: false,
    format: 'uuid',
    description:
      'Narrow to clinics with at least one active branch in this city.',
  })
  @ApiOkResponse({ description: 'Matching public clinics (cards).' })
  @Get('clinics')
  clinics(@Query('q') q?: string, @Query('cityId') cityId?: string) {
    return this.discovery.searchClinics(q, undefined, cityId);
  }

  @Public()
  @ApiOperation({
    summary: 'Public clinic detail: branches, services, doctors',
  })
  @ApiOkResponse({ description: 'Clinic public detail for the booking flow.' })
  @Get('clinics/:id')
  clinic(@Param('id', ParseUUIDPipe) id: string) {
    return this.discovery.clinicDetail(id);
  }
}

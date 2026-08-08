import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { TenantApprovalStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import {
  createMockDataSource,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

import { ClinicSupportProfileService } from './clinic-support-profile.service';
import { SupportClinicResolver } from './support-clinic.resolver';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A `tenants` row as the DATABASE would hand it back if the resolver's
 * `select` were ever widened by accident — deliberately including columns
 * Support must never receive, so the "exact key set" assertions below are
 * proving a real exclusion rather than the absence of test data.
 */
const rawTenantRow = {
  id: TENANT_ID,
  name: 'Bright Smile Clinic',
  slug: 'bright-smile',
  contact_email: 'clinic@example.com',
  contact_phone: '+966501234567',
  default_timezone: 'Asia/Riyadh',
  default_currency: 'SAR',
  approval_status: TenantApprovalStatus.APPROVED,
  is_active: true,
  created_at: new Date('2026-01-15T09:00:00.000Z'),
  // Must never surface:
  commercial_registration_number: 'CR-1234567890',
  legal_name: 'Bright Smile Medical Company LLC',
  logo_url: 'https://cdn.example/logo.png',
  country_id: 966,
  updated_at: new Date('2026-02-01T00:00:00.000Z'),
  deleted_at: null,
};

describe('ClinicSupportProfileService', () => {
  let service: ClinicSupportProfileService;
  let tenants: MockRepository;
  let branches: MockRepository;
  let settings: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    tenants = createMockRepository();
    branches = createMockRepository();
    settings = createMockRepository();
    dataSource = createMockDataSource();

    tenants.findOne.mockResolvedValue(rawTenantRow);
    tenants.exists.mockResolvedValue(true);
    dataSource.query.mockResolvedValue([
      {
        active_staff: 7,
        bookable_staff: 4,
        active_services: 12,
        staff_with_schedules: 3,
      },
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ClinicSupportProfileService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(TenantSetting), useValue: settings },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(ClinicSupportProfileService);
  });

  describe('profile', () => {
    it('returns exactly the allow-listed clinic keys — no verification, registration or branding data', async () => {
      branches.find.mockResolvedValue([]);

      const result = await service.profile(TENANT_ID);

      expect(Object.keys(result).sort()).toEqual(['clinic', 'structure']);
      expect(Object.keys(result.clinic).sort()).toEqual(
        [
          'approvalStatus',
          'contactEmail',
          'contactPhone',
          'createdAt',
          'currency',
          'id',
          'isActive',
          'name',
          'slug',
          'timezone',
        ].sort(),
      );
      // The raw row carried these; the projection must not.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('CR-1234567890');
      expect(serialized).not.toContain('Bright Smile Medical Company LLC');
      expect(serialized).not.toContain('logo.png');
    });

    it('asks the database for a narrow column list rather than the whole tenant row', async () => {
      branches.find.mockResolvedValue([]);
      await service.profile(TENANT_ID);

      const [args] = tenants.findOne.mock.calls[0];
      expect(args.select).toBeDefined();
      expect(args.select).not.toHaveProperty('commercial_registration_number');
      expect(args.select).not.toHaveProperty('legal_name');
      expect(args.select).not.toHaveProperty('logo_url');
    });

    it('summarises branch structure with active/total counts and per-branch status', async () => {
      branches.find.mockResolvedValue([
        { id: 'b1', name: 'Main', is_active: true, timezone: 'Asia/Riyadh' },
        { id: 'b2', name: 'North', is_active: false, timezone: 'Asia/Riyadh' },
      ]);

      const { structure } = await service.profile(TENANT_ID);

      expect(structure.branchesTotal).toBe(2);
      expect(structure.branchesActive).toBe(1);
      expect(structure.branches).toEqual([
        { id: 'b1', name: 'Main', isActive: true, timezone: 'Asia/Riyadh' },
        { id: 'b2', name: 'North', isActive: false, timezone: 'Asia/Riyadh' },
      ]);
      expect(structure.activeStaffCount).toBe(7);
      expect(structure.bookableStaffCount).toBe(4);
      expect(structure.activeServiceCount).toBe(12);
      expect(structure.staffWithSchedulesCount).toBe(3);
    });

    it('computes every structure count in ONE database statement — no N+1 as a clinic grows', async () => {
      branches.find.mockResolvedValue([
        { id: 'b1', name: 'A', is_active: true, timezone: 'UTC' },
        { id: 'b2', name: 'B', is_active: true, timezone: 'UTC' },
        { id: 'b3', name: 'C', is_active: true, timezone: 'UTC' },
      ]);

      await service.profile(TENANT_ID);

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      expect(branches.find).toHaveBeenCalledTimes(1);
      expect(tenants.findOne).toHaveBeenCalledTimes(1);
    });

    it('404s an unknown clinic instead of returning an empty profile', async () => {
      tenants.findOne.mockResolvedValue(null);

      await expect(service.profile(TENANT_ID)).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
      await expect(service.profile(TENANT_ID)).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('configuration', () => {
    const settingsRow = {
      id: 'set-1',
      booking_confirmation: 'MANUAL',
      payment_required: true,
      cancellation_hours: 24,
      feedback_delay_minutes: 360,
      default_language: 'ar',
      currency: 'SAR',
      bot_enabled: false,
      public_booking_enabled: false,
      updated_at: new Date('2026-03-01T12:00:00.000Z'),
    };

    it('returns exactly the allow-listed settings keys plus a derived readiness block', async () => {
      settings.findOne.mockResolvedValue(settingsRow);

      const result = await service.configuration(TENANT_ID);

      expect(Object.keys(result).sort()).toEqual(['configured', 'readiness', 'settings']);
      expect(Object.keys(result.settings!).sort()).toEqual(
        [
          'bookingConfirmation',
          'botEnabled',
          'cancellationHours',
          'currency',
          'defaultLanguage',
          'feedbackDelayMinutes',
          'paymentRequired',
          'publicBookingEnabled',
          'updatedAt',
        ].sort(),
      );
      expect(result.settings).toMatchObject({
        botEnabled: false,
        publicBookingEnabled: false,
        paymentRequired: true,
        defaultLanguage: 'ar',
      });
    });

    it('reports a clinic with no settings row as unconfigured rather than 404 — that state IS the diagnosis', async () => {
      settings.findOne.mockResolvedValue(null);

      const result = await service.configuration(TENANT_ID);

      expect(result.configured).toBe(false);
      expect(result.settings).toBeNull();
      expect(result.readiness.publicBookingEnabled).toBe(false);
      expect(result.readiness.paymentRequired).toBeNull();
    });

    it('derives booking readiness from the structure counts, so "why can nobody book?" is answerable at a glance', async () => {
      settings.findOne.mockResolvedValue(settingsRow);
      dataSource.query.mockResolvedValue([
        { active_staff: 2, bookable_staff: 0, active_services: 0, staff_with_schedules: 0 },
      ]);

      const { readiness } = await service.configuration(TENANT_ID);

      expect(readiness).toEqual({
        hasBookableStaff: false,
        hasActiveServices: false,
        hasSchedules: false,
        publicBookingEnabled: false,
        paymentRequired: true,
      });
    });

    it('404s an unknown clinic', async () => {
      tenants.exists.mockResolvedValue(false);

      await expect(service.configuration(TENANT_ID)).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
    });
  });
});

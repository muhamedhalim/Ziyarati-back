import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Workbook } from 'exceljs';

import { ServiceImportService } from './service-import.service';
import { ServiceService } from './service.service';
import { Service } from '../../entities/Services/Service';
import { ServiceCategory } from '../../entities/Services/ServiceCategory';
import { AppError, ErrorCode } from '../../common/errors';
import type { UploadedFileLike } from '../storage/uploads.controller';
import {
  SERVICE_IMPORT_COLUMNS,
  SERVICE_IMPORT_MAX_BYTES,
  SERVICE_IMPORT_MAX_ROWS,
} from './service-import.constants';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TENANT = 't1';
const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';

async function buildXlsx(
  headers: string[],
  rows: unknown[][],
): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(headers);
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function fileFrom(
  buffer: Buffer,
  overrides: Partial<UploadedFileLike> = {},
): UploadedFileLike {
  return {
    originalname: 'services.xlsx',
    mimetype: XLSX_MIME,
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

const HEADERS = SERVICE_IMPORT_COLUMNS.map((c) => c.headers[0]);

/** A valid row; override any column by DTO field name. */
function row(overrides: Record<string, unknown> = {}): unknown[] {
  const base: Record<string, unknown> = {
    name: 'Deep cleaning',
    description: 'Scaling and polishing',
    durationMinutes: 45,
    pricingType: 'FIXED',
    basePrice: 250,
    category: '',
    isActive: 'yes',
  };
  const merged = { ...base, ...overrides };
  return SERVICE_IMPORT_COLUMNS.map((c) => merged[c.field] ?? '');
}

describe('ServiceImportService', () => {
  let service: ServiceImportService;
  let services: MockRepository;
  let categories: MockRepository;
  let serviceService: { create: jest.Mock };

  beforeEach(async () => {
    services = createMockRepository();
    categories = createMockRepository();
    serviceService = { create: jest.fn(async () => ({ id: 's1' })) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceImportService,
        { provide: getRepositoryToken(Service), useValue: services },
        { provide: getRepositoryToken(ServiceCategory), useValue: categories },
        { provide: ServiceService, useValue: serviceService },
      ],
    }).compile();
    service = moduleRef.get(ServiceImportService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('file-level rejections (shared upload policy)', () => {
    it('rejects when no file is uploaded', async () => {
      await expect(
        service.validateFile(TENANT, undefined),
      ).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });

    it('rejects a file over the size cap', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      await expect(
        service.validateFile(
          TENANT,
          fileFrom(buffer, { size: SERVICE_IMPORT_MAX_BYTES + 1 }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
    });

    it('rejects a legacy .xls / wrong MIME', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      await expect(
        service.validateFile(
          TENANT,
          fileFrom(buffer, {
            mimetype: 'application/vnd.ms-excel',
            originalname: 'services.xls',
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_FILE_TYPE });
    });

    it('rejects an extension that does not match the declared MIME', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      await expect(
        service.validateFile(
          TENANT,
          fileFrom(buffer, { originalname: 'services.csv' }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_FILE_TYPE });
    });

    it('rejects spoofed content (right MIME + extension, not a real xlsx)', async () => {
      const file = fileFrom(
        Buffer.from('MZ this is an executable pretending to be a spreadsheet'),
      );
      await expect(service.validateFile(TENANT, file)).rejects.toBeInstanceOf(
        AppError,
      );
    });

    it('rejects a sheet missing a required column and names it', async () => {
      const buffer = await buildXlsx(['Name', 'Price'], [['Cleaning', 10]]);
      await expect(
        service.validateFile(TENANT, fileFrom(buffer)),
      ).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
        message: expect.stringContaining('Duration (Minutes)'),
      });
    });

    it('rejects a header-only sheet', async () => {
      const buffer = await buildXlsx(HEADERS, []);
      await expect(
        service.validateFile(TENANT, fileFrom(buffer)),
      ).rejects.toMatchObject({
        message: expect.stringContaining('no data rows'),
      });
    });

    it('rejects more data rows than the cap', async () => {
      const rows = Array.from({ length: SERVICE_IMPORT_MAX_ROWS + 1 }, (_, i) =>
        row({ name: `Service ${i}` }),
      );
      const buffer = await buildXlsx(HEADERS, rows);
      await expect(
        service.validateFile(TENANT, fileFrom(buffer)),
      ).rejects.toMatchObject({
        message: expect.stringContaining(String(SERVICE_IMPORT_MAX_ROWS)),
      });
    });
  });

  describe('validateFile — row validation', () => {
    it('accepts a valid row and returns its data with the sheet row number', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result).toMatchObject({
        totalRows: 1,
        validCount: 1,
        invalidCount: 0,
      });
      expect(result.rows[0]).toMatchObject({
        row: 2,
        valid: true,
        data: {
          name: 'Deep cleaning',
          durationMinutes: 45,
          basePrice: 250,
          pricingType: 'FIXED',
          isActive: true,
        },
      });
    });

    it('treats optional columns as optional', async () => {
      const buffer = await buildXlsx(
        ['Name', 'Duration (minutes)'],
        [['Consultation', 20]],
      );
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(true);
      expect(result.rows[0].data.pricingType).toBeUndefined();
    });

    it('accepts header aliases and a lower-case pricing type', async () => {
      const buffer = await buildXlsx(
        ['Service Name', 'Duration', 'Pricing Type', 'Base Price'],
        [['Checkup', 15, 'variable', 0]],
      );
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0]).toMatchObject({
        valid: true,
        data: { name: 'Checkup', pricingType: 'VARIABLE', basePrice: 0 },
      });
    });

    it.each([
      ['a missing name', { name: '' }, 'name'],
      ['a missing duration', { durationMinutes: '' }, 'durationMinutes'],
      ['a zero duration', { durationMinutes: 0 }, 'durationMinutes'],
      ['a fractional duration', { durationMinutes: 10.5 }, 'durationMinutes'],
      ['a negative price', { basePrice: -1 }, 'basePrice'],
      ['3-decimal price', { basePrice: 1.234 }, 'basePrice'],
      ['an unknown pricing type', { pricingType: 'HOURLY' }, 'pricingType'],
      ['a name over 255 chars', { name: 'x'.repeat(256) }, 'name'],
    ])('flags %s', async (_label, overrides, field) => {
      const buffer = await buildXlsx(HEADERS, [row(overrides)]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
      expect(result.rows[0].errors.join(' ')).toContain(field);
    });

    it('gives ONE friendly message for a non-numeric duration/price (no duplicate DTO noise)', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ durationMinutes: 'soon', basePrice: 'free' }),
      ]);
      const { errors } = (await service.validateFile(TENANT, fileFrom(buffer)))
        .rows[0];
      expect(errors).toEqual([
        'durationMinutes: "soon" is not a number',
        'basePrice: "free" is not a number',
      ]);
    });

    it('rejects an unrecognised active token', async () => {
      const buffer = await buildXlsx(HEADERS, [row({ isActive: 'maybe' })]);
      const { errors } = (await service.validateFile(TENANT, fileFrom(buffer)))
        .rows[0];
      expect(errors.join(' ')).toContain('active: must be yes/no');
    });

    it('flags a duplicate name within the file, pointing at the first row', async () => {
      const buffer = await buildXlsx(HEADERS, [row(), row()]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(true);
      expect(result.rows[1].errors).toEqual([
        'Duplicate name — already used by row 2 in this file',
      ]);
    });

    it('flags a name that already exists in this tenant, with one bulk query', async () => {
      services.find.mockResolvedValueOnce([{ name: 'Deep cleaning' }]);
      const buffer = await buildXlsx(HEADERS, [
        row(),
        row({ name: 'Whitening' }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].errors).toEqual([
        'A service with this name already exists',
      ]);
      expect(result.rows[1].valid).toBe(true);
      expect(services.find).toHaveBeenCalledTimes(1);
      expect(services.find.mock.calls[0][0].where.tenant).toEqual({
        id: TENANT,
      });
    });

    it('does not run the DB name lookup when every row is already invalid', async () => {
      const buffer = await buildXlsx(HEADERS, [row({ durationMinutes: 0 })]);
      await service.validateFile(TENANT, fileFrom(buffer));
      expect(services.find).not.toHaveBeenCalled();
    });

    it('never writes during preview', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      await service.validateFile(TENANT, fileFrom(buffer));
      expect(serviceService.create).not.toHaveBeenCalled();
      expect(services.save).not.toHaveBeenCalled();
    });
  });

  describe("categories are resolved by NAME, inside the caller's tenant only", () => {
    it('looks categories up scoped to the tenant', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      await service.validateFile(TENANT, fileFrom(buffer));
      expect(categories.find.mock.calls[0][0].where).toEqual({
        tenant: { id: TENANT },
      });
    });

    it('matches case-insensitively and accepts an active category', async () => {
      categories.find.mockResolvedValue([
        { id: CATEGORY_ID, name: 'Dental', is_active: true },
      ]);
      const buffer = await buildXlsx(HEADERS, [row({ category: '  dental ' })]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(true);
    });

    it("flags a category that does not exist (another tenant's category is simply invisible)", async () => {
      const buffer = await buildXlsx(HEADERS, [row({ category: 'Dental' })]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
      expect(result.rows[0].errors[0]).toContain(
        'Category "Dental" does not exist',
      );
    });

    it('flags an inactive category', async () => {
      categories.find.mockResolvedValue([
        { id: CATEGORY_ID, name: 'Dental', is_active: false },
      ]);
      const buffer = await buildXlsx(HEADERS, [row({ category: 'Dental' })]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].errors).toEqual(['Category "Dental" is inactive']);
    });

    it('does not accept a raw category id in the sheet as a category reference', async () => {
      const buffer = await buildXlsx(HEADERS, [row({ category: CATEGORY_ID })]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
    });
  });

  describe('commit', () => {
    it('creates each valid row through ServiceService.create with the resolved category id', async () => {
      categories.find.mockResolvedValue([
        { id: CATEGORY_ID, name: 'Dental', is_active: true },
      ]);
      const buffer = await buildXlsx(HEADERS, [
        row({ category: 'Dental' }),
        row({ name: 'Whitening' }),
      ]);
      const result = await service.commit(TENANT, fileFrom(buffer));

      expect(result).toEqual({
        totalRows: 2,
        imported: 2,
        rejected: 0,
        errors: [],
      });
      expect(serviceService.create).toHaveBeenCalledTimes(2);
      const [tenant, dto] = serviceService.create.mock.calls[0];
      expect(tenant).toBe(TENANT);
      expect(dto).toMatchObject({
        name: 'Deep cleaning',
        durationMinutes: 45,
        basePrice: 250,
        pricingType: 'FIXED',
        categoryId: CATEGORY_ID,
        isActive: true,
      });
      expect(serviceService.create.mock.calls[1][1].categoryId).toBeUndefined();
    });

    it('skips invalid rows without aborting the batch, reporting them by sheet row', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ name: 'Good' }),
        row({ name: 'Bad', durationMinutes: 0 }),
      ]);
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(result.imported).toBe(1);
      expect(result.rejected).toBe(1);
      expect(result.errors).toEqual([{ row: 3, messages: expect.any(Array) }]);
      expect(serviceService.create).toHaveBeenCalledTimes(1);
    });

    it('reports a row that loses a race at create() and keeps going', async () => {
      serviceService.create
        .mockRejectedValueOnce(
          new AppError(ErrorCode.CONFLICT, {
            message: 'A service with this name already exists',
          }),
        )
        .mockResolvedValueOnce({ id: 's2' });
      const buffer = await buildXlsx(HEADERS, [
        row({ name: 'A' }),
        row({ name: 'B' }),
      ]);
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(result).toEqual({
        totalRows: 2,
        imported: 1,
        rejected: 1,
        errors: [
          { row: 2, messages: ['A service with this name already exists'] },
        ],
      });
    });

    it('hides the details of an unexpected error', async () => {
      serviceService.create.mockRejectedValueOnce(
        new Error('connection string postgres://user:pw@host'),
      );
      const buffer = await buildXlsx(HEADERS, [row()]);
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(result.errors[0].messages).toEqual([
        'This row could not be imported due to an unexpected error.',
      ]);
    });

    it('re-validates instead of trusting a preview (existing name blocks the write)', async () => {
      services.find.mockResolvedValueOnce([{ name: 'Deep cleaning' }]);
      const buffer = await buildXlsx(HEADERS, [row()]);
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(result.imported).toBe(0);
      expect(serviceService.create).not.toHaveBeenCalled();
    });
  });

  describe('buildTemplate', () => {
    it('produces a workbook whose own headers and example row pass validation', async () => {
      const template = await service.buildTemplate();
      const result = await service.validateFile(
        TENANT,
        fileFrom(template, { originalname: 'service-import-template.xlsx' }),
      );
      expect(result.totalRows).toBe(1);
      expect(result.rows[0].errors).toEqual([]);
      expect(result.rows[0].valid).toBe(true);
    });

    it('has an Instructions sheet describing every column', async () => {
      const wb = new Workbook();
      await wb.xlsx.load((await service.buildTemplate()) as never);
      const notes = wb.getWorksheet('Instructions')!;
      expect(notes.rowCount).toBe(SERVICE_IMPORT_COLUMNS.length + 1);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Workbook } from 'exceljs';

import { CustomerImportService } from './customer-import.service';
import { CustomerService } from './customer.service';
import { Customer } from '../../entities/CRM/Customer';
import { AppError, ErrorCode } from '../../common/errors';
import { UploadedFileLike } from '../storage/uploads.controller';
import {
  CUSTOMER_IMPORT_COLUMNS,
  CUSTOMER_IMPORT_MAX_BYTES,
  CUSTOMER_IMPORT_MAX_ROWS,
} from './customer-import.constants';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TENANT = 't1';

async function buildXlsx(
  headers: string[],
  rows: unknown[][],
): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(headers);
  rows.forEach((r) => sheet.addRow(r));
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function fileFrom(
  buffer: Buffer,
  overrides: Partial<UploadedFileLike> = {},
): UploadedFileLike {
  return {
    originalname: 'customers.xlsx',
    mimetype: XLSX_MIME,
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

const HEADERS = CUSTOMER_IMPORT_COLUMNS.map((c) => c.headers[0]);

function row(overrides: Record<string, unknown> = {}): unknown[] {
  const base: Record<string, unknown> = {
    full_name: 'Sara Test',
    phone: '+966500000001',
    email: 'sara@example.com',
    national_id: '',
    gender: 'female',
    date_of_birth: '1990-05-20',
    preferred_locale: 'en',
    source: 'walk_in',
    marketing_opt_in: 'no',
    has_chronic_diseases: 'no',
    chronic_diseases: '',
    has_health_insurance: 'no',
  };
  const merged = { ...base, ...overrides };
  return CUSTOMER_IMPORT_COLUMNS.map((c) => merged[c.field] ?? '');
}

describe('CustomerImportService', () => {
  let service: CustomerImportService;
  let customers: MockRepository;
  let customerService: { create: jest.Mock };

  beforeEach(async () => {
    customers = createMockRepository();
    customerService = { create: jest.fn(async () => ({ id: 'c1' })) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerImportService,
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: CustomerService, useValue: customerService },
      ],
    }).compile();
    service = moduleRef.get(CustomerImportService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('validateFile — file-level rejections', () => {
    it('rejects when no file is uploaded', async () => {
      await expect(
        service.validateFile(TENANT, undefined),
      ).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });

    it('rejects a file over the size cap', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      const file = fileFrom(buffer, { size: CUSTOMER_IMPORT_MAX_BYTES + 1 });
      await expect(service.validateFile(TENANT, file)).rejects.toMatchObject({
        code: ErrorCode.FILE_TOO_LARGE,
      });
    });

    it('rejects a non-xlsx mimetype', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      const file = fileFrom(buffer, {
        mimetype: 'application/vnd.ms-excel',
        originalname: 'customers.xls',
      });
      await expect(service.validateFile(TENANT, file)).rejects.toMatchObject({
        code: ErrorCode.UNSUPPORTED_FILE_TYPE,
      });
    });

    it('rejects when the extension does not match the declared mimetype', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      const file = fileFrom(buffer, { originalname: 'customers.txt' });
      await expect(service.validateFile(TENANT, file)).rejects.toMatchObject({
        code: ErrorCode.UNSUPPORTED_FILE_TYPE,
      });
    });

    it('rejects a file whose bytes are not actually a valid xlsx (spoofed content-type)', async () => {
      const file = fileFrom(
        Buffer.from('not a real spreadsheet, just plain bytes padding out'),
      );
      await expect(service.validateFile(TENANT, file)).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });

    it('rejects a file missing a required column', async () => {
      const buffer = await buildXlsx(
        ['Full Name', 'Email'],
        [['Sara', 'sara@example.com']],
      );
      await expect(
        service.validateFile(TENANT, fileFrom(buffer)),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects a file with no data rows', async () => {
      const buffer = await buildXlsx(HEADERS, []);
      await expect(
        service.validateFile(TENANT, fileFrom(buffer)),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects a file with more data rows than the cap', async () => {
      const rows = Array.from(
        { length: CUSTOMER_IMPORT_MAX_ROWS + 1 },
        (_, i) =>
          row({
            email: `p${i}@example.com`,
            phone: `+9665000${String(i).padStart(4, '0')}`,
          }),
      );
      const buffer = await buildXlsx(HEADERS, rows);
      await expect(
        service.validateFile(TENANT, fileFrom(buffer)),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    }, 15_000);
  });

  describe('validateFile — row validation', () => {
    it('accepts a fully valid row', async () => {
      const buffer = await buildXlsx(HEADERS, [row()]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.totalRows).toBe(1);
      expect(result.validCount).toBe(1);
      expect(result.rows[0]).toMatchObject({ valid: true, row: 2 });
      expect(result.rows[0].data.email).toBe('sara@example.com');
    });

    it('rejects a row missing the required phone', async () => {
      const buffer = await buildXlsx(HEADERS, [row({ phone: '' })]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
      expect(result.rows[0].errors.join(' ')).toMatch(/phone/i);
    });

    it('rejects a row with an invalid email format', async () => {
      const buffer = await buildXlsx(HEADERS, [row({ email: 'not-an-email' })]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
    });

    it('flags the second row of an in-file duplicate email, leaving the first valid', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ email: 'dup@example.com', phone: '+966500000001' }),
        row({ email: 'dup@example.com', phone: '+966500000002' }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(true);
      expect(result.rows[1].valid).toBe(false);
      expect(result.rows[1].errors.join(' ')).toMatch(/duplicate email/i);
    });

    it('flags the second row of an in-file duplicate national_id, leaving the first valid', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ national_id: 'ID-1', email: 'a@example.com' }),
        row({ national_id: 'ID-1', email: 'b@example.com' }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(true);
      expect(result.rows[1].valid).toBe(false);
      expect(result.rows[1].errors.join(' ')).toMatch(/duplicate id number/i);
    });

    // Product requirement: phone is NOT a uniqueness/duplicate key — see
    // Customer.ts. Two rows sharing a phone must both stay valid.
    it('does NOT treat a shared phone number across rows as a duplicate', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ email: 'a@example.com', phone: '+966500000009' }),
        row({ email: 'b@example.com', phone: '+966500000009' }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(true);
      expect(result.rows[1].valid).toBe(true);
    });

    it('flags a row whose email already exists for the tenant in the database', async () => {
      customers.find.mockImplementationOnce(async () => [
        { email: 'exists@example.com' },
      ]);
      const buffer = await buildXlsx(HEADERS, [
        row({ email: 'exists@example.com' }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
      expect(result.rows[0].errors.join(' ')).toMatch(/already exists/i);
    });

    it('flags a row whose national_id already exists for the tenant in the database', async () => {
      customers.find
        .mockImplementationOnce(async () => []) // email check — no conflict
        .mockImplementationOnce(async () => [{ national_id: 'ID-9' }]); // national_id check — conflict
      const buffer = await buildXlsx(HEADERS, [row({ national_id: 'ID-9' })]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
      expect(result.rows[0].errors.join(' ')).toMatch(
        /id number already exists/i,
      );
    });

    it.each(['yes', 'true', '1'])(
      'parses "%s" as true for boolean columns',
      async (token) => {
        const buffer = await buildXlsx(HEADERS, [
          row({ marketing_opt_in: token }),
        ]);
        const result = await service.validateFile(TENANT, fileFrom(buffer));
        expect(result.rows[0].data.marketing_opt_in).toBe(true);
      },
    );

    it.each(['no', 'false', '0'])(
      'parses "%s" as false for boolean columns',
      async (token) => {
        const buffer = await buildXlsx(HEADERS, [
          row({ marketing_opt_in: token }),
        ]);
        const result = await service.validateFile(TENANT, fileFrom(buffer));
        expect(result.rows[0].data.marketing_opt_in).toBe(false);
      },
    );

    it('rejects an unrecognized token in a boolean column', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ marketing_opt_in: 'maybe' }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
      expect(result.rows[0].errors.join(' ')).toMatch(/marketing_opt_in/);
    });

    it('rejects has_chronic_diseases=yes without chronic disease details (server-side DTO rule)', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ has_chronic_diseases: 'yes', chronic_diseases: '' }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(false);
    });

    it('accepts has_chronic_diseases=yes with details provided', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({
          has_chronic_diseases: 'yes',
          chronic_diseases: 'Type 2 diabetes',
        }),
      ]);
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.rows[0].valid).toBe(true);
      expect(result.rows[0].data.chronic_diseases).toBe('Type 2 diabetes');
    });
  });

  describe('commit', () => {
    it('imports every valid row through CustomerService.create and reports counts', async () => {
      const buffer = await buildXlsx(HEADERS, [
        row({ email: 'a@example.com', phone: '+966500000001' }),
        row({ email: 'b@example.com', phone: '+966500000002' }),
      ]);
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(customerService.create).toHaveBeenCalledTimes(2);
      expect(customerService.create).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ email: 'a@example.com' }),
        // Consent given in an import is recorded as such, not as a staff entry.
        { source: 'import' },
      );
      expect(result).toMatchObject({ totalRows: 2, imported: 2, rejected: 0 });
    });

    it('never calls CustomerService.create for an invalid row, and reports it as rejected', async () => {
      const buffer = await buildXlsx(HEADERS, [row({ phone: '' })]);
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(customerService.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ totalRows: 1, imported: 0, rejected: 1 });
      expect(result.errors[0].row).toBe(2);
    });

    it("one row's failure does not abort the rest of the batch (per-row isolation)", async () => {
      customerService.create
        .mockImplementationOnce(async () => {
          throw new AppError(ErrorCode.CONFLICT, {
            message: 'A customer with this email already exists',
          });
        })
        .mockImplementationOnce(async () => ({ id: 'c2' }));
      const buffer = await buildXlsx(HEADERS, [
        row({ email: 'a@example.com', phone: '+966500000001' }),
        row({ email: 'b@example.com', phone: '+966500000002' }),
      ]);
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(result.imported).toBe(1);
      expect(result.rejected).toBe(1);
      expect(result.errors[0].messages[0]).toMatch(/already exists/i);
    });

    it('re-validates the file rather than trusting any prior state', async () => {
      const buffer = await buildXlsx(HEADERS, [row({ national_id: 'ID-1' })]);
      customers.find
        .mockImplementationOnce(async () => []) // email
        .mockImplementationOnce(async () => [{ national_id: 'ID-1' }]); // national_id already exists
      const result = await service.commit(TENANT, fileFrom(buffer));
      expect(customerService.create).not.toHaveBeenCalled();
      expect(result.rejected).toBe(1);
    });
  });

  describe('buildTemplate', () => {
    it('produces a workbook whose header row this same service can parse, and whose example row is valid', async () => {
      const buffer = await service.buildTemplate();
      const result = await service.validateFile(TENANT, fileFrom(buffer));
      expect(result.totalRows).toBe(1);
      expect(result.validCount).toBe(1);
    });
  });
});

import { ReportExportController } from './report-export.controller';
import { ReportExportService } from './report-export.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ErrorCode } from '../../common/errors';
import { ExportJobState } from '../../entities/enums';

const TENANT = 'tenant-1';
const USER = { id: 'user-1', tenantId: TENANT, roles: [], permissions: [] };

/**
 * T184 (spec 014, US13, F13). The four routes' status-code shape:
 * 200/202 on create, 200 status, 302/202/409/404 on download.
 */
describe('ReportExportController (T184)', () => {
  let controller: ReportExportController;
  let exports: {
    requestExport: jest.Mock;
    getStatus: jest.Mock;
    getDownload: jest.Mock;
  };
  let ctx: { requireTenantId: jest.Mock; getUser: jest.Mock };
  let res: {
    status: jest.Mock;
    setHeader: jest.Mock;
    redirect: jest.Mock;
    json: jest.Mock;
    send: jest.Mock;
  };

  beforeEach(() => {
    exports = {
      requestExport: jest.fn(),
      getStatus: jest.fn(),
      getDownload: jest.fn(),
    };
    ctx = {
      requireTenantId: jest.fn().mockReturnValue(TENANT),
      getUser: jest.fn().mockReturnValue(USER),
    };
    res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      redirect: jest.fn(),
      json: jest.fn(),
      send: jest.fn(),
    };
    controller = new ReportExportController(
      exports as unknown as ReportExportService,
      ctx as unknown as TenantContextService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('returns the file body with 200 for a synchronous export', async () => {
      exports.requestExport.mockResolvedValueOnce({
        kind: 'sync',
        buffer: Buffer.from('xlsx-bytes'),
        filename: 'staff-performance.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      await controller.create(
        { report: 'staff-performance' } as any,
        res as any,
      );

      expect(res.send).toHaveBeenCalledWith(Buffer.from('xlsx-bytes'));
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="staff-performance.xlsx"',
      );
    });

    it('returns 202 { jobId } for a background export', async () => {
      exports.requestExport.mockResolvedValueOnce({
        kind: 'async',
        jobId: 'job-1',
      });

      await controller.create(
        { report: 'staff-performance' } as any,
        res as any,
      );

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({ jobId: 'job-1' });
    });

    it('rejects when no authenticated user is present', async () => {
      ctx.getUser.mockReturnValueOnce(null);
      await expect(
        controller.create({ report: 'staff-performance' } as any, res as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(exports.requestExport).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('delegates to the service with the tenant-scoped job id', async () => {
      exports.getStatus.mockResolvedValueOnce({
        state: ExportJobState.READY,
        rowCount: 5,
      });
      const result = await controller.getStatus('job-1');
      expect(result).toEqual({ state: ExportJobState.READY, rowCount: 5 });
      expect(exports.getStatus).toHaveBeenCalledWith(TENANT, 'job-1');
    });
  });

  describe('download', () => {
    it('redirects (302) to the signed URL when ready', async () => {
      exports.getDownload.mockResolvedValueOnce({
        pending: false,
        url: 'https://signed.example/x.xlsx',
      });

      await controller.download('job-1', res as any);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        'https://signed.example/x.xlsx',
      );
    });

    it('returns 202 { state } while still preparing, without redirecting', async () => {
      exports.getDownload.mockResolvedValueOnce({
        pending: true,
        state: ExportJobState.RUNNING,
      });

      await controller.download('job-1', res as any);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({ state: ExportJobState.RUNNING });
      expect(res.redirect).not.toHaveBeenCalled();
    });

    it('propagates the service’s CONFLICT/NOT_FOUND errors unchanged (T178 asserts the status codes)', async () => {
      const conflict = Object.assign(new Error('expired'), {
        code: ErrorCode.CONFLICT,
        publicContext: { state: ExportJobState.EXPIRED },
      });
      exports.getDownload.mockRejectedValueOnce(conflict);

      await expect(controller.download('job-1', res as any)).rejects.toBe(
        conflict,
      );
    });
  });
});

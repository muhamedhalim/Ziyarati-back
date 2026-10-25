import { UploadsController } from './uploads.controller';

/** POST /uploads writes the object, then the audit row. */
describe('UploadsController.upload — object and audit row stay consistent', () => {
  const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const stored = {
    storageKey: `${TENANT}/commercial_registration/x.pdf`,
    filename: 'cr.pdf',
    mimeType: 'application/pdf',
    size: 8,
    sha256: 'abc',
  };
  const file = {
    originalname: 'cr.pdf',
    mimetype: 'application/pdf',
    size: 8,
    buffer: Buffer.from('%PDF-1.4'),
  };
  const dto = { docType: 'commercial_registration' } as any;

  function setup() {
    const storage = {
      upload: jest.fn().mockResolvedValue(stored),
      discardOrphan: jest.fn().mockResolvedValue(undefined),
    };
    const ctx = {
      requireTenantId: () => TENANT,
      getUser: () => ({ roles: ['OWNER'] }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new UploadsController(
      storage as any,
      ctx as any,
      audit as any,
    );
    return { controller, storage, audit };
  }

  it('returns the stored object and keeps it when the audit row is written', async () => {
    const { controller, storage, audit } = setup();

    await expect(
      controller.upload(file, dto, 'user-1', '203.0.113.9', 'jest'),
    ).resolves.toEqual(stored);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(storage.discardOrphan).not.toHaveBeenCalled();
  });

  it('removes the object when the audit row cannot be written, and rethrows the original error', async () => {
    const { controller, storage, audit } = setup();
    audit.record.mockRejectedValue(new Error('audit db down'));

    await expect(
      controller.upload(file, dto, 'user-1', '203.0.113.9', 'jest'),
    ).rejects.toThrow('audit db down');

    expect(storage.discardOrphan).toHaveBeenCalledWith(
      stored.storageKey,
      TENANT,
    );
  });

  it('rejects a request without a file before touching storage', async () => {
    const { controller, storage } = setup();

    await expect(
      controller.upload(undefined, dto, 'user-1', '203.0.113.9', 'jest'),
    ).rejects.toMatchObject({ message: expect.stringContaining('No file') });

    expect(storage.upload).not.toHaveBeenCalled();
  });
});

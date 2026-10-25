import { ConfigService } from '@nestjs/config';

import { AiTrainingFileService } from './ai-training-file.service';

/**
 * `uploadContent` writes the file to private storage FIRST. When the row cannot be
 * registered afterwards (quota re-check, agent check, database error) the object must
 * not be left behind with nothing referencing it.
 */
describe('AiTrainingFileService.uploadContent — no orphaned object on a failed registration', () => {
  const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const KEY = `${TENANT}/ai_training/x.txt`;
  const file = {
    originalname: 'faq.txt',
    mimetype: 'text/plain',
    size: 5,
    buffer: Buffer.from('hello'),
  };

  function setup() {
    const storage = {
      upload: jest.fn().mockResolvedValue({
        storageKey: KEY,
        filename: 'faq.txt',
        mimeType: 'text/plain',
        size: 5,
        sha256: 'x',
      }),
      discardOrphan: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AiTrainingFileService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      storage as any,
      new ConfigService({ AI_TRAINING_FILE_MAX_BYTES: 1024 }),
      {} as any,
    );
    jest
      .spyOn(service as any, 'assertTrainingFileQuota')
      .mockResolvedValue(undefined);
    return { service, storage };
  }

  it('discards the stored object when registering the row fails, and rethrows the original error', async () => {
    const { service, storage } = setup();
    jest
      .spyOn(service, 'upload')
      .mockRejectedValue(new Error('quota exceeded'));

    await expect(service.uploadContent(TENANT, file)).rejects.toThrow(
      'quota exceeded',
    );

    expect(storage.discardOrphan).toHaveBeenCalledWith(KEY, TENANT);
  });

  it('keeps the object when the row is registered', async () => {
    const { service, storage } = setup();
    jest.spyOn(service, 'upload').mockResolvedValue({ id: 'f1' } as any);

    await expect(service.uploadContent(TENANT, file)).resolves.toEqual({
      id: 'f1',
    });

    expect(storage.discardOrphan).not.toHaveBeenCalled();
  });

  it('writes nothing and discards nothing when storage refuses the file', async () => {
    const { service, storage } = setup();
    storage.upload.mockRejectedValue(new Error('unsupported type'));
    const upload = jest.spyOn(service, 'upload');

    await expect(service.uploadContent(TENANT, file)).rejects.toThrow(
      'unsupported type',
    );

    expect(upload).not.toHaveBeenCalled();
    expect(storage.discardOrphan).not.toHaveBeenCalled();
  });
});

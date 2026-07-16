import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappMediaService } from './whatsapp-media.service';
import { MetaGraphClient } from './meta-graph.client';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';
import { StorageService } from '../../storage/storage.service';
import { QueueService } from '../../../queue/queue.service';
import { Message } from '../../../entities/Conversations/Message';
import { MessageAttachment } from '../../../entities/Conversations/MessageAttachment';
import { WHATSAPP_MEDIA_UPLOAD_POLICY } from '../../storage/storage.constants';
import { createMockRepository, MockRepository } from '../../../../test/utils/mock-factories';
import type { MetaWebhookMessage } from '../webhooks/whatsapp-webhook.types';

const TENANT = 't1';

const JOB = {
  tenantId: TENANT,
  accountId: 'acc-1',
  messageId: 'msg-1',
  mediaId: 'media-1',
  mediaType: 'image',
};

describe('WhatsappMediaService', () => {
  let service: WhatsappMediaService;
  let messages: MockRepository;
  let attachments: MockRepository;
  let graph: { getMediaMetadata: jest.Mock; downloadMedia: jest.Mock };
  let resolver: { byId: jest.Mock };
  let storage: { upload: jest.Mock; sanitizeFilename: jest.Mock };
  let queue: { enqueueWhatsappMediaDownload: jest.Mock };

  beforeEach(async () => {
    messages = createMockRepository();
    attachments = createMockRepository();
    attachments.create.mockImplementation((v: object) => ({ ...v }));
    messages.findOne.mockResolvedValue({ id: 'msg-1' });
    attachments.exists.mockResolvedValue(false);

    graph = {
      getMediaMetadata: jest
        .fn()
        .mockResolvedValue({ url: 'https://lookaside/x', mimeType: 'image/jpeg' }),
      downloadMedia: jest.fn().mockResolvedValue({ buffer: Buffer.from('bytes') }),
    };
    resolver = { byId: jest.fn().mockResolvedValue({ id: 'acc-1', accessToken: 'tok' }) };
    storage = {
      upload: jest.fn().mockResolvedValue({ storageKey: 't1/whatsapp-image/uuid.jpg' }),
      sanitizeFilename: jest.fn((v: string) => v),
    };
    queue = { enqueueWhatsappMediaDownload: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappMediaService,
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(MessageAttachment), useValue: attachments },
        { provide: MetaGraphClient, useValue: graph },
        { provide: WhatsappAccountResolver, useValue: resolver },
        { provide: StorageService, useValue: storage },
        { provide: QueueService, useValue: queue },
      ],
    }).compile();
    service = moduleRef.get(WhatsappMediaService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('detection + extraction', () => {
    it.each(['image', 'document', 'audio', 'video', 'sticker'])(
      'recognises an inbound %s as media',
      (type) => {
        expect(
          WhatsappMediaService.isMediaMessage({ type } as MetaWebhookMessage),
        ).toBe(true);
      },
    );

    it('does not treat text/interactive as media', () => {
      expect(WhatsappMediaService.isMediaMessage({ type: 'text' } as MetaWebhookMessage)).toBe(
        false,
      );
      expect(
        WhatsappMediaService.isMediaMessage({ type: 'interactive' } as MetaWebhookMessage),
      ).toBe(false);
    });

    it('extracts the media id from the type-named key Meta nests it under', () => {
      const extracted = WhatsappMediaService.extract({
        type: 'document',
        document: { id: 'm-9', mime_type: 'application/pdf', filename: 'report.pdf' },
      } as unknown as MetaWebhookMessage);

      expect(extracted).toEqual({
        mediaId: 'm-9',
        mediaType: 'document',
        mimeType: 'application/pdf',
        filename: 'report.pdf',
      });
    });

    it('returns null when the media object carries no id', () => {
      expect(
        WhatsappMediaService.extract({ type: 'image', image: {} } as unknown as MetaWebhookMessage),
      ).toBeNull();
    });
  });

  describe('enqueueForMessage', () => {
    it('queues a download for a media message', async () => {
      await service.enqueueForMessage(TENANT, 'acc-1', 'msg-1', {
        type: 'image',
        image: { id: 'm-1', mime_type: 'image/jpeg' },
      } as unknown as MetaWebhookMessage);

      expect(queue.enqueueWhatsappMediaDownload).toHaveBeenCalledWith(
        expect.objectContaining({ mediaId: 'm-1', mediaType: 'image', messageId: 'msg-1' }),
      );
    });

    it('does nothing for a non-media message', async () => {
      await service.enqueueForMessage(TENANT, 'acc-1', 'msg-1', {
        type: 'text',
      } as MetaWebhookMessage);

      expect(queue.enqueueWhatsappMediaDownload).not.toHaveBeenCalled();
    });

    it('never throws when enqueueing fails — media must not break the turn', async () => {
      queue.enqueueWhatsappMediaDownload.mockRejectedValueOnce(new Error('redis down'));

      await expect(
        service.enqueueForMessage(TENANT, 'acc-1', 'msg-1', {
          type: 'image',
          image: { id: 'm-1' },
        } as unknown as MetaWebhookMessage),
      ).resolves.toBeUndefined();
    });
  });

  describe('downloadAndAttach', () => {
    it('downloads with the TENANT\'s credential and stores under the media policy', async () => {
      await service.downloadAndAttach(JOB);

      // A media id is only readable with the token of the WABA that received it.
      expect(resolver.byId).toHaveBeenCalledWith(TENANT, 'acc-1');
      expect(graph.downloadMedia).toHaveBeenCalledWith(
        'https://lookaside/x',
        'tok',
        expect.any(Number),
      );
      expect(storage.upload).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, mimeType: 'image/jpeg' }),
        // NOT the stricter verification-document policy.
        WHATSAPP_MEDIA_UPLOAD_POLICY,
      );
    });

    it('persists the storage KEY, never a public URL', async () => {
      await service.downloadAndAttach(JOB);

      expect(attachments.create).toHaveBeenCalledWith(
        expect.objectContaining({ file_url: 't1/whatsapp-image/uuid.jpg' }),
      );
      // Patient media is served only via short-lived signed URLs.
      expect(attachments.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ file_url: expect.stringContaining('lookaside') }),
      );
    });

    it('records the provider media id as the idempotency key', async () => {
      await service.downloadAndAttach(JOB);
      expect(attachments.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider_media_id: 'media-1' }),
      );
    });

    it('is idempotent — a retried job does not attach or download twice', async () => {
      attachments.exists.mockResolvedValueOnce(true);

      const res = await service.downloadAndAttach(JOB);

      expect(res).toMatchObject({ attached: false, reason: 'already-attached' });
      expect(graph.downloadMedia).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('no-ops when the message is gone (or belongs to another tenant)', async () => {
      messages.findOne.mockResolvedValueOnce(null);

      const res = await service.downloadAndAttach(JOB);

      expect(res).toMatchObject({ attached: false, reason: 'message-missing' });
      expect(graph.getMediaMetadata).not.toHaveBeenCalled();
    });

    it('scopes the message lookup to the tenant', async () => {
      await service.downloadAndAttach(JOB);
      expect(messages.findOne.mock.calls[0][0].where).toMatchObject({
        id: 'msg-1',
        tenant: { id: TENANT },
      });
    });

    it('records an unsupported type WITHOUT bytes rather than dropping it', async () => {
      graph.getMediaMetadata.mockResolvedValueOnce({
        url: 'https://lookaside/x',
        mimeType: 'application/x-msdownload',
      });

      const res = await service.downloadAndAttach(JOB);

      // Staff must still see that a file arrived; silently dropping it would
      // make the conversation lie about what the patient sent.
      expect(res).toMatchObject({ attached: true, reason: 'unsupported-type' });
      expect(graph.downloadMedia).not.toHaveBeenCalled();
      expect(attachments.create).toHaveBeenCalledWith(
        expect.objectContaining({ file_url: undefined, file_type: 'application/x-msdownload' }),
      );
    });

    it('strips a charset parameter before matching the MIME', async () => {
      graph.getMediaMetadata.mockResolvedValueOnce({
        url: 'https://lookaside/x',
        mimeType: 'text/plain; charset=utf-8',
      });

      const res = await service.downloadAndAttach(JOB);

      expect(res).toMatchObject({ attached: true });
      expect(storage.upload).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'text/plain' }),
        WHATSAPP_MEDIA_UPLOAD_POLICY,
      );
    });

    it('re-resolves the download URL each attempt (Meta URLs expire in minutes)', async () => {
      await service.downloadAndAttach(JOB);
      // The job stores the media ID, not a URL — this is what makes a retry
      // hours later still work.
      expect(graph.getMediaMetadata).toHaveBeenCalledWith('media-1', 'tok');
    });
  });
});

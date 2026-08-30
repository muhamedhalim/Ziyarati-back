import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CampaignFanoutService } from './campaign-fanout.service';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignExecution } from '../../entities/enums';
import { CustomerSegmentService } from '../crm/customer-segment.service';
import { QueueService } from '../../queue/queue.service';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const CAMPAIGN = 'campaign-1';
const RUN = 'run-1';

describe('CampaignFanoutService — segment-aware fan-out (T125, FR-S007)', () => {
  let service: CampaignFanoutService;
  let runs: MockRepository;
  let recipients: MockRepository;
  let campaigns: MockRepository;
  let segments: { resolve: jest.Mock };
  let queue: {
    enqueueCampaignRecipientsBulk: jest.Mock;
    enqueueCampaignFanoutChunk: jest.Mock;
  };

  beforeEach(async () => {
    runs = createMockRepository();
    runs.findOne.mockResolvedValue({
      id: RUN,
      execution: CampaignExecution.PROCESSING,
    });
    recipients = createMockRepository();
    campaigns = createMockRepository();
    segments = { resolve: jest.fn() };
    queue = {
      enqueueCampaignRecipientsBulk: jest.fn().mockResolvedValue(undefined),
      enqueueCampaignFanoutChunk: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignFanoutService,
        { provide: getRepositoryToken(CampaignRun), useValue: runs },
        {
          provide: getRepositoryToken(CampaignRecipient),
          useValue: recipients,
        },
        { provide: getRepositoryToken(Campaign), useValue: campaigns },
        { provide: QueueService, useValue: queue },
        { provide: CustomerSegmentService, useValue: segments },
      ],
    }).compile();
    service = moduleRef.get(CampaignFanoutService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('explicit-list campaigns (no segment) — pre-existing behaviour, unaffected', () => {
    it('reads PENDING recipient rows directly, never calling segments.resolve', async () => {
      campaigns.findOne.mockResolvedValueOnce({
        id: CAMPAIGN,
        audience_segment: null,
      });
      const qb = createMockQueryBuilder();
      qb.getRawMany.mockResolvedValueOnce([{ id: 'rec-1' }, { id: 'rec-2' }]);
      recipients.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.handleChunk(TENANT, CAMPAIGN, RUN, null);

      expect(segments.resolve).not.toHaveBeenCalled();
      expect(queue.enqueueCampaignRecipientsBulk).toHaveBeenCalledWith([
        {
          data: {
            tenantId: TENANT,
            campaignId: CAMPAIGN,
            runId: RUN,
            recipientId: 'rec-1',
            correlationId: undefined,
          },
        },
        {
          data: {
            tenantId: TENANT,
            campaignId: CAMPAIGN,
            runId: RUN,
            recipientId: 'rec-2',
            correlationId: undefined,
          },
        },
      ]);
      expect(result.enqueued).toBe(2);
    });

    it('settles the run COMPLETED, gated on the counts, when the window is empty', async () => {
      campaigns.findOne.mockResolvedValueOnce({
        id: CAMPAIGN,
        audience_segment: null,
      });
      const selectQb = createMockQueryBuilder();
      selectQb.getRawMany.mockResolvedValueOnce([]);
      const updateQb = createMockQueryBuilder();
      recipients.createQueryBuilder.mockReturnValueOnce(selectQb);
      runs.createQueryBuilder.mockReturnValueOnce(updateQb);

      const result = await service.handleChunk(TENANT, CAMPAIGN, RUN, null);

      expect(updateQb.andWhere).toHaveBeenCalledWith(
        '(sent + failed + skipped) >= total_recipients',
      );
      expect(result).toEqual({ enqueued: 0, nextCursor: null });
    });
  });

  describe('segment campaigns — resolves live, materialises PENDING rows, then enqueues', () => {
    it('resolves one keyset window of customer ids and enqueues their (freshly inserted) recipient rows', async () => {
      campaigns.findOne.mockResolvedValueOnce({
        id: CAMPAIGN,
        audience_segment: { id: 'seg-1' },
      });
      segments.resolve.mockResolvedValueOnce({
        customerIds: ['cust-1', 'cust-2'],
        nextCursor: 'cust-2',
      });
      const insertQb = createMockQueryBuilder();
      const selectQb = createMockQueryBuilder();
      selectQb.getRawMany.mockResolvedValueOnce([
        { id: 'rec-1' },
        { id: 'rec-2' },
      ]);
      recipients.createQueryBuilder
        .mockReturnValueOnce(insertQb)
        .mockReturnValueOnce(selectQb);

      const result = await service.handleChunk(TENANT, CAMPAIGN, RUN, null);

      expect(segments.resolve).toHaveBeenCalledWith(
        TENANT,
        'seg-1',
        null,
        expect.any(Number),
      );
      expect(insertQb.insert).toHaveBeenCalled();
      expect(insertQb.orIgnore).toHaveBeenCalled();
      expect(insertQb.values).toHaveBeenCalledWith([
        expect.objectContaining({ customer: { id: 'cust-1' } }),
        expect.objectContaining({ customer: { id: 'cust-2' } }),
      ]);
      expect(queue.enqueueCampaignRecipientsBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          data: expect.objectContaining({ recipientId: 'rec-1' }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({ recipientId: 'rec-2' }),
        }),
      ]);
      expect(result.enqueued).toBe(2);
      expect(result.nextCursor).toBe('cust-2');
    });

    it('enqueues the NEXT chunk with the customer-id cursor, not a recipient id', async () => {
      campaigns.findOne.mockResolvedValueOnce({
        id: CAMPAIGN,
        audience_segment: { id: 'seg-1' },
      });
      segments.resolve.mockResolvedValueOnce({
        customerIds: ['cust-1'],
        nextCursor: 'cust-1',
      });
      const insertQb = createMockQueryBuilder();
      const selectQb = createMockQueryBuilder();
      selectQb.getRawMany.mockResolvedValueOnce([{ id: 'rec-1' }]);
      recipients.createQueryBuilder
        .mockReturnValueOnce(insertQb)
        .mockReturnValueOnce(selectQb);

      await service.handleChunk(TENANT, CAMPAIGN, RUN, null);

      expect(queue.enqueueCampaignFanoutChunk).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cust-1' }),
      );
    });

    it('completes the run UNCONDITIONALLY (no count gate) once segment resolution is exhausted', async () => {
      campaigns.findOne.mockResolvedValueOnce({
        id: CAMPAIGN,
        audience_segment: { id: 'seg-1' },
      });
      segments.resolve.mockResolvedValueOnce({
        customerIds: [],
        nextCursor: null,
      });
      const updateQb = createMockQueryBuilder();
      runs.createQueryBuilder.mockReturnValueOnce(updateQb);

      const result = await service.handleChunk(
        TENANT,
        CAMPAIGN,
        RUN,
        'cust-99',
      );

      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ execution: CampaignExecution.COMPLETED }),
      );
      // Unlike the explicit-list path, no count-matching gate is applied.
      expect(updateQb.andWhere).not.toHaveBeenCalledWith(
        '(sent + failed + skipped) >= total_recipients',
      );
      expect(result).toEqual({ enqueued: 0, nextCursor: null });
    });

    it('a retried chunk (orIgnore hit) only enqueues rows still PENDING, never a re-dispatch', async () => {
      campaigns.findOne.mockResolvedValueOnce({
        id: CAMPAIGN,
        audience_segment: { id: 'seg-1' },
      });
      segments.resolve.mockResolvedValueOnce({
        customerIds: ['cust-1', 'cust-2'],
        nextCursor: 'cust-2',
      });
      const insertQb = createMockQueryBuilder();
      const selectQb = createMockQueryBuilder();
      // cust-1's row already dispatched by a prior attempt of this same chunk —
      // the re-select only returns cust-2's still-PENDING row.
      selectQb.getRawMany.mockResolvedValueOnce([{ id: 'rec-2' }]);
      recipients.createQueryBuilder
        .mockReturnValueOnce(insertQb)
        .mockReturnValueOnce(selectQb);

      const result = await service.handleChunk(TENANT, CAMPAIGN, RUN, null);

      expect(result.enqueued).toBe(1);
      expect(queue.enqueueCampaignRecipientsBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          data: expect.objectContaining({ recipientId: 'rec-2' }),
        }),
      ]);
    });
  });

  it('does nothing if the run is not PROCESSING (cancelled/failed/completed before the relay published)', async () => {
    runs.findOne.mockResolvedValueOnce({
      id: RUN,
      execution: CampaignExecution.COMPLETED,
    });
    const result = await service.handleChunk(TENANT, CAMPAIGN, RUN, null);
    expect(result).toEqual({ enqueued: 0, nextCursor: null });
    expect(campaigns.findOne).not.toHaveBeenCalled();
  });
});

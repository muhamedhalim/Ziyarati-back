import { CampaignDlqRecoveryProcessor } from './campaign-dlq-recovery.processor';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { CampaignDispatchService } from '../../modules/campaigns/campaign-dispatch.service';

describe('CampaignDlqRecoveryProcessor (FND-020)', () => {
  const build = (lockToken: string | null) => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(lockToken),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dispatch = {
      recoverDeadLetters: jest.fn().mockResolvedValue({ recovered: 2, attempted: 3 }),
    };
    const processor = new CampaignDlqRecoveryProcessor(
      lock as unknown as DistributedLockService,
      dispatch as unknown as CampaignDispatchService,
    );
    return { processor, lock, dispatch };
  };

  it('acquires the lock, sweeps, and releases the lock afterwards', async () => {
    const { processor, lock, dispatch } = build('token-abc');

    const result = await processor.process({ data: { tenantId: null } } as any);

    expect(dispatch.recoverDeadLetters).toHaveBeenCalled();
    expect(result).toEqual({ recovered: 2, attempted: 3 });
    expect(lock.release).toHaveBeenCalledWith('lock:campaigns-recover-dlq', 'token-abc');
  });

  it('skips the sweep entirely when the lock is already held elsewhere (prevents duplicate execution under a BullMQ stall-redelivery)', async () => {
    const { processor, dispatch, lock } = build(null);

    const result = await processor.process({ data: { tenantId: null } } as any);

    expect(dispatch.recoverDeadLetters).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('still releases the lock if the recovery call throws', async () => {
    const { processor, lock, dispatch } = build('token-xyz');
    dispatch.recoverDeadLetters.mockRejectedValueOnce(new Error('db error'));

    await expect(
      processor.process({ data: { tenantId: null } } as any),
    ).rejects.toThrow('db error');
    expect(lock.release).toHaveBeenCalledWith('lock:campaigns-recover-dlq', 'token-xyz');
  });
});

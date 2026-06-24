import { WhatsappMessageRouter } from './whatsapp-message.router';
import { WhatsappAccountResolver } from './whatsapp-account.resolver';

describe('WhatsappMessageRouter', () => {
  let router: WhatsappMessageRouter;
  let resolver: { byId: jest.Mock; forBranch: jest.Mock };

  beforeEach(() => {
    resolver = { byId: jest.fn().mockResolvedValue({ id: 'acc' }), forBranch: jest.fn().mockResolvedValue({ id: 'branch-acc' }) };
    router = new WhatsappMessageRouter(resolver as unknown as WhatsappAccountResolver);
  });

  it('routes by explicit accountId when provided (takes precedence)', async () => {
    await router.resolveForSend('tenant-1', { accountId: 'acc-9', branchId: 'b-1' });
    expect(resolver.byId).toHaveBeenCalledWith('tenant-1', 'acc-9');
    expect(resolver.forBranch).not.toHaveBeenCalled();
  });

  it('routes by branch (hybrid CUSTOM→PLATFORM) when no accountId is given', async () => {
    await router.resolveForSend('tenant-1', { branchId: 'b-1' });
    expect(resolver.forBranch).toHaveBeenCalledWith('tenant-1', 'b-1');
    expect(resolver.byId).not.toHaveBeenCalled();
  });

  it('falls back to the platform number when neither account nor branch is given', async () => {
    await router.resolveForSend('tenant-1');
    expect(resolver.forBranch).toHaveBeenCalledWith('tenant-1', undefined);
  });
});

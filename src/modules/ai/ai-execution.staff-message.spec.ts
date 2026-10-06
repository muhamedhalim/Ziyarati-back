import { AiExecutionService } from './ai-execution.service';

/**
 * `recordStaffMessage` touches only two repositories, so it is exercised on the
 * real prototype with just those — building the whole execution service (a
 * provider router, quota, RAG, …) would test none of it.
 */
describe('AiExecutionService.recordStaffMessage', () => {
  let aiConversations: { findOne: jest.Mock };
  let messages: { create: jest.Mock; save: jest.Mock };
  let service: AiExecutionService;

  beforeEach(() => {
    aiConversations = { findOne: jest.fn().mockResolvedValue({ id: 'ai-1' }) };
    messages = {
      create: jest.fn((x: object) => x),
      save: jest.fn().mockResolvedValue(undefined),
    };
    service = Object.create(AiExecutionService.prototype);
    Object.assign(service, { aiConversations, messages });
  });

  it('adds the person’s message to the AI session linked to the conversation, as an attributed assistant message', async () => {
    await expect(
      service.recordStaffMessage('t1', 'conv-1', 'u1', 'We open at 9'),
    ).resolves.toBe(true);

    expect(messages.save).toHaveBeenCalledWith({
      ai_conversation_id: 'ai-1',
      tenant: { id: 't1' },
      role: 'assistant',
      content: 'We open at 9',
      tokens_used: 0,
      agent_user_id: 'u1',
    });
  });

  it('finds the session inside the caller’s tenant, newest first', async () => {
    await service.recordStaffMessage('t1', 'conv-1', 'u1', 'x');

    expect(aiConversations.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversation: { id: 'conv-1' }, tenant: { id: 't1' } },
        order: { created_at: 'DESC' },
      }),
    );
  });

  it('selects the column it sorts by — TypeORM fails a relation-filtered lookup that sorts on an unselected column', async () => {
    await service.recordStaffMessage('t1', 'conv-1', 'u1', 'x');

    const options = aiConversations.findOne.mock.calls[0][0];
    expect(options.select).toEqual({ id: true, created_at: true });
  });

  it('writes nothing and returns false when the conversation has no AI session', async () => {
    aiConversations.findOne.mockResolvedValue(null);

    await expect(
      service.recordStaffMessage('t1', 'conv-1', 'u1', 'x'),
    ).resolves.toBe(false);
    expect(messages.save).not.toHaveBeenCalled();
  });

  it('costs no tokens — the model is not involved', async () => {
    await service.recordStaffMessage('t1', 'conv-1', 'u1', 'x');

    expect(messages.save.mock.calls[0][0].tokens_used).toBe(0);
  });
});

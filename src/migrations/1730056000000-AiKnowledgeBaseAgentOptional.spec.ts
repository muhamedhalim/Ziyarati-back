import { AiKnowledgeBaseAgentOptional1730056000000 } from './1730056000000-AiKnowledgeBaseAgentOptional';

describe('AiKnowledgeBaseAgentOptional migration', () => {
  it('drops the NOT NULL constraint on ai_kb_embeddings.agent_id', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiKnowledgeBaseAgentOptional1730056000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(
      'ALTER TABLE IF EXISTS ai_kb_embeddings ALTER COLUMN agent_id DROP NOT NULL',
    );
  });

  it('down restores the NOT NULL constraint', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiKnowledgeBaseAgentOptional1730056000000().down({
      query,
    } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(
      'ALTER TABLE IF EXISTS ai_kb_embeddings ALTER COLUMN agent_id SET NOT NULL',
    );
  });
});

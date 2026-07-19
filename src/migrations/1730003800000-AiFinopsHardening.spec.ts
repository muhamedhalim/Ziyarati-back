import { AiFinopsHardening1730003800000 } from './1730003800000-AiFinopsHardening';

describe('AiFinopsHardening migration', () => {
  it('is additive for existing rows and creates the accounting/idempotency constraints', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiFinopsHardening1730003800000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ai_cost_entries');
    expect(sql).toContain('uq_ai_cost_entry_idempotency');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ai_request_executions');
    expect(sql).toContain('uq_ai_request_execution');
    expect(sql).toContain('uq_ai_kb_source_content_hash');
    expect(sql).toContain("status='PENDING'");
  });

  it('keeps historical additive columns while dropping only the reversible runtime tables/index', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiFinopsHardening1730003800000().down({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('DROP TABLE IF EXISTS ai_request_executions');
    expect(sql).toContain('DROP TABLE IF EXISTS ai_cost_entries');
    expect(sql).not.toContain('DROP COLUMN');
  });
});

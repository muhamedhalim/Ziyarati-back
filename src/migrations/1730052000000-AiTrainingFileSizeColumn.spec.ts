import { AiTrainingFileSizeColumn1730052000000 } from './1730052000000-AiTrainingFileSizeColumn';

describe('AiTrainingFileSizeColumn migration', () => {
  it('adds a nullable bigint file_size column', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiTrainingFileSizeColumn1730052000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(
      'ALTER TABLE "ai_training_files" ADD COLUMN IF NOT EXISTS "file_size" bigint',
    );
  });

  it('down drops the column', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AiTrainingFileSizeColumn1730052000000().down({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain('ALTER TABLE "ai_training_files" DROP COLUMN IF EXISTS "file_size"');
  });
});

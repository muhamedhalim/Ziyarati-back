import { EmailSuppressionAndCampaignChannel1730079000000 } from './1730079000000-EmailSuppressionAndCampaignChannel';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue(undefined);
  await run({ query } as never);
  return query.mock.calls.map(([statement]) => statement as string);
};

describe('EmailSuppressionAndCampaignChannel migration (T130)', () => {
  it('creates email_suppressions with a per-tenant (never global) unique constraint', async () => {
    const statements = await sqlOf((q) =>
      new EmailSuppressionAndCampaignChannel1730079000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS "email_suppressions"');
    expect(joined).toContain('UQ_email_suppressions_tenant_email');
    expect(joined).toContain('("tenant_id", "email")');
    expect(joined).toContain(
      'FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE',
    );
  });

  it('adds campaigns.channel NOT NULL DEFAULT WHATSAPP — existing campaigns read back unchanged', async () => {
    const statements = await sqlOf((q) =>
      new EmailSuppressionAndCampaignChannel1730079000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).toContain(
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "channel" varchar(16) NOT NULL DEFAULT \'WHATSAPP\'',
    );
  });

  it('adds nullable email_subject/email_body on campaigns and email on campaign_recipients', async () => {
    const statements = await sqlOf((q) =>
      new EmailSuppressionAndCampaignChannel1730079000000().up(q as never),
    );
    const joined = statements.join('\n');
    expect(joined).toContain(
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "email_subject" varchar(200)',
    );
    expect(joined).toContain(
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "email_body" text',
    );
    expect(joined).toContain(
      'ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "email" varchar(255)',
    );
    // Neither new campaigns column is declared NOT NULL — both are optional.
    expect(joined).not.toContain('"email_subject" varchar(200) NOT NULL');
    expect(joined).not.toContain('"email_body" text NOT NULL');
  });

  it('down() reverses every statement in FK-safe order (columns, then the table)', async () => {
    const statements = await sqlOf((q) =>
      new EmailSuppressionAndCampaignChannel1730079000000().down(q as never),
    );
    expect(statements[0]).toContain(
      'ALTER TABLE "campaign_recipients" DROP COLUMN IF EXISTS "email"',
    );
    expect(statements[statements.length - 1]).toContain(
      'DROP TABLE IF EXISTS "email_suppressions"',
    );
    expect(
      statements.some((s) => s.includes('DROP COLUMN IF EXISTS "channel"')),
    ).toBe(true);
  });
});

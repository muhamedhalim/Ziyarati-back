import 'dotenv/config';
import { SeedDataSource } from '../src/seed/data-source';
import { User } from '../src/entities/Auth&RBAC/User';

async function main() {
  await SeedDataSource.initialize();
  const user = await SeedDataSource.manager.findOne(User, {
    where: { email: 'text1@gmail.com' },
    relations: { tenant: true },
  });
  if (!user) {
    console.log('NOT FOUND');
  } else {
    console.log(JSON.stringify({
      id: user.id,
      email: user.email,
      is_active: user.is_active,
      updated_at: user.updated_at,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
      tenantId: user.tenant?.id,
    }, null, 2));
  }
  await SeedDataSource.destroy();
}
main().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});

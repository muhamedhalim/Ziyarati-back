const { NestFactory } = require('@nestjs/core');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
async function main() {
  const { AppModule } = require('./dist/src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  await app.close();
  console.log('API_BOOT_OK');
}
main()
  .then(() => setTimeout(() => process.exit(0), 200))
  .catch((e) => {
    console.error('API_BOOT_FAIL');
    console.error(e && e.stack ? e.stack : e);
    setTimeout(() => process.exit(1), 500);
  });

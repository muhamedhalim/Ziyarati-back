import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';

import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      cache: true,
      validate,
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('TypeORM');

        const nodeEnv = config.get<string>('NODE_ENV');
        const isProduction = nodeEnv === 'production';

        const databaseUrl = config.get<string>('DATABASE_URL');

        if (!databaseUrl) {
          throw new Error('❌ DATABASE_URL is missing in .env');
        }

        const enableSync =
          config.get<string>('TYPEORM_SYNCHRONIZE') === 'true';

        const logging =
          config.get<string>('TYPEORM_LOGGING') === 'true';

        // =========================
        // SAFE SYNC RULE
        // =========================
        const synchronize = !isProduction && enableSync;

        if (isProduction && enableSync) {
          throw new Error(
            '❌ TypeORM synchronize is NOT allowed in production',
          );
        }

        if (synchronize) {
          logger.warn(
            '⚠️ TypeORM synchronize ENABLED (DEV ONLY)',
          );
        }

        const ssl = isProduction
          ? { rejectUnauthorized: false }
          : false;

        return {
          type: 'postgres',
          url: databaseUrl,

          autoLoadEntities: true,

          // fallback explicit loader (VERY IMPORTANT)
          entities: [__dirname + '/**/*.entity{.ts,.js}'],

          synchronize,
          migrationsRun: !synchronize,

          logging: logging
            ? ['query', 'error', 'warn']
            : ['error'],

          ssl,

          extra: {
            max: config.get<number>('DB_POOL_MAX', 10) ?? 10,
            min: config.get<number>('DB_POOL_MIN', 1) ?? 1,
            idleTimeoutMillis:
              config.get<number>('DB_POOL_IDLE_TIMEOUT', 30000),
          },
        };
      },
    }),

    AuthModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,

    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
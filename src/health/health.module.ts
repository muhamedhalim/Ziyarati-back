import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Health endpoints. Depends only on the global QueueService for Redis + queue
 * readiness — no extra wiring needed.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}

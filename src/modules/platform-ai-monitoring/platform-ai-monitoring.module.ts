import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module';
import { AiMonitoringService } from './ai-monitoring.service';
import { PlatformAiMonitoringController } from './platform-ai-monitoring.controller';

/**
 * Super-admin AI monitoring (Feature 10). Read-only aggregation over the existing
 * AI stores + the global `QueueService`. No TypeORM entities of its own (raw
 * DataSource queries over ai_usage_logs / ai_cost_logs / ai_conversations).
 */
@Module({
  imports: [PlatformModule],
  controllers: [PlatformAiMonitoringController],
  providers: [AiMonitoringService],
})
export class PlatformAiMonitoringModule {}

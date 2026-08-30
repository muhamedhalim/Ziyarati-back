import { Module } from '@nestjs/common';

import { ActivityLogController } from './activity-log.controller';
import { ActivityLogService } from './activity-log.service';

/**
 * Spec 014 (Clinic Platform Completion) — clinic-facing activity/audit log
 * (US14). Scaffolded empty in T006; T191/T193 land the service and
 * controller. A read-only projection over the existing `audit_logs` table
 * (via raw `DataSource` queries, following `SupportActivityService`'s own
 * pattern) — no entity is registered here because none is written.
 */
@Module({
  controllers: [ActivityLogController],
  providers: [ActivityLogService],
})
export class ActivityLogModule {}

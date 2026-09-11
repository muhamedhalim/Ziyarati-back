import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * `GET /dashboard/summary`'s only query param.
 *
 * `branchId` is NEVER trusted directly: the service confirms it belongs to
 * this tenant (404 otherwise — mirrors `AppointmentService.assertBranch`) and
 * is inside the caller's OWN branch scope (403 otherwise — reuses
 * `BranchScopeService.assertBranchAllowed`, same as `ActivityLogController`)
 * before it narrows a single count.
 */
export class DashboardSummaryQueryDto {
  @ApiPropertyOptional({
    description:
      'Narrow every branch-dependent KPI (appointments, myPatients, staff) to ' +
      'one branch. Omitted = the caller\'s full scope ("All branches").',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

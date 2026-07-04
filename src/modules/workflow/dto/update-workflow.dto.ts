import { PartialType } from '@nestjs/swagger';

import { CreateWorkflowDto } from './create-workflow.dto';

/** Partial update of a workflow (any subset of the create fields). */
export class UpdateWorkflowDto extends PartialType(CreateWorkflowDto) {}

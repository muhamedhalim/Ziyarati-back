import { PartialType } from '@nestjs/swagger';
import { CreateAiAgentDto } from './create-ai-agent.dto';

/** Partial update of an AI agent. */
export class UpdateAiAgentDto extends PartialType(CreateAiAgentDto) {}

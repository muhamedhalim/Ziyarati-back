import { PartialType } from '@nestjs/swagger';
import { CreateAiPromptDto } from './create-ai-prompt.dto';

/** Partial update of an AI prompt. */
export class UpdateAiPromptDto extends PartialType(CreateAiPromptDto) {}

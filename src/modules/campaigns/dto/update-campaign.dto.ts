import { PartialType } from '@nestjs/swagger';
import { CreateCampaignDto } from './create-campaign.dto';

/**
 * Partial update of a campaign. Only allowed while the campaign is in an
 * editable status (DRAFT / SCHEDULED / PAUSED) — enforced in the service.
 * Status changes go through the dedicated lifecycle endpoints, never here.
 */
export class UpdateCampaignDto extends PartialType(CreateCampaignDto) {}

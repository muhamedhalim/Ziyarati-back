import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_COMPONENT_TYPES,
  WHATSAPP_TEMPLATE_BUTTON_TYPES,
  WHATSAPP_TEMPLATE_LANGUAGE_PATTERN,
  WHATSAPP_TEMPLATE_NAME_PATTERN,
} from '../whatsapp.constants';

/**
 * One quick-reply / call-to-action button on a BUTTONS component.
 *
 * Only the fields Meta requires per button type are modelled. `url` and
 * `phone_number` are validated as present-when-relevant in
 * `WhatsappTemplateService`, not here: a class-validator conditional would have
 * to duplicate the type switch that already exists there.
 */
export class WhatsappTemplateButtonDto {
  @ApiProperty({ enum: WHATSAPP_TEMPLATE_BUTTON_TYPES, example: 'QUICK_REPLY' })
  @IsIn(WHATSAPP_TEMPLATE_BUTTON_TYPES)
  type!: string;

  @ApiProperty({ description: 'Button label shown to the recipient.', example: 'Confirm', maxLength: 25 })
  @IsString()
  @MinLength(1)
  @MaxLength(25)
  text!: string;

  @ApiPropertyOptional({ description: 'Destination for a `URL` button.', example: 'https://ziyaratech.com/appointments' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @ApiPropertyOptional({ description: 'E.164 number for a `PHONE_NUMBER` button.', example: '+966501234567' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;
}

/**
 * One component of the template, in Meta's own vocabulary.
 *
 * `type` is upper-case because that is what Meta accepts and what
 * `WhatsappTemplateSyncService` already stores when it mirrors a template back
 * from Meta — authoring and syncing must produce the SAME stored shape, or the
 * send path's `missingVariables()` (which looks for `type === 'BODY'`) would
 * only work for synced templates.
 */
export class WhatsappTemplateComponentDto {
  @ApiProperty({ enum: WHATSAPP_TEMPLATE_COMPONENT_TYPES, example: 'BODY' })
  @IsIn(WHATSAPP_TEMPLATE_COMPONENT_TYPES)
  type!: string;

  @ApiPropertyOptional({
    description: 'Only `TEXT` is supported. Media headers are not implemented.',
    enum: ['TEXT'],
  })
  @IsOptional()
  @IsIn(['TEXT'])
  format?: string;

  @ApiPropertyOptional({
    description:
      'Component text. Required for HEADER/BODY/FOOTER. BODY may contain `{{1}}`, `{{2}}`, … placeholders.',
    example: 'Hello {{1}}, this is a reminder for your appointment on {{2}}.',
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  text?: string;

  @ApiPropertyOptional({
    description:
      'Sample value for each `{{n}}` placeholder, in order. Meta REQUIRES these whenever the component declares placeholders — a template submitted without them is rejected.',
    type: [String],
    example: ['Mohamed', '12 August 2026 at 5:00 PM'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @MaxLength(300, { each: true })
  example?: string[];

  @ApiPropertyOptional({ type: [WhatsappTemplateButtonDto], description: 'Buttons for a BUTTONS component (max 3).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => WhatsappTemplateButtonDto)
  buttons?: WhatsappTemplateButtonDto[];
}

/**
 * Creates a WhatsApp message template.
 *
 * This is a WRITE THROUGH TO META, not a local record: the service submits it
 * to `POST /{waba-id}/message_templates` and only then persists the mirror row.
 *
 * SECURITY — what this DTO deliberately does NOT accept:
 *   `status`, `provider_template_id`, `wabaId`, any Meta credential, `tenantId`.
 *
 * `status` in particular is Meta's verdict, taken from Meta's own response.
 * Accepting it from a client is exactly the GAP-002 self-approval hole: an
 * `approved` template is unconditionally sendable
 * (`WhatsappTemplateService.getSendableTemplate`), so a tenant that could name
 * its own status could push messages Meta never reviewed. The tenant comes from
 * the authenticated principal; the WABA comes from the resolved account.
 */
export class CreateWhatsappTemplateDto {
  @ApiProperty({
    description:
      'Meta template name: lower-case letters, digits and underscores only, max 512 chars.',
    example: 'appointment_reminder_review_test',
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(WHATSAPP_TEMPLATE_NAME_PATTERN, {
    message: 'name must contain only lower-case letters, digits and underscores',
  })
  name!: string;

  @ApiProperty({
    description:
      'Meta language code — `en`, `en_US`, `ar`, `pt_BR`, … Must match the code the template is later SENT with.',
    example: 'en_US',
    maxLength: 10,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(10)
  @Matches(WHATSAPP_TEMPLATE_LANGUAGE_PATTERN, {
    message: 'language must be a Meta language code such as `en`, `en_US` or `ar`',
  })
  language!: string;

  @ApiProperty({
    description: 'Meta template category.',
    enum: WHATSAPP_TEMPLATE_CATEGORIES,
    example: 'UTILITY',
  })
  @IsIn(WHATSAPP_TEMPLATE_CATEGORIES)
  category!: string;

  @ApiProperty({
    type: [WhatsappTemplateComponentDto],
    description:
      'Template components. Exactly one BODY is required; HEADER, FOOTER and BUTTONS are optional.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => WhatsappTemplateComponentDto)
  components!: WhatsappTemplateComponentDto[];

  @ApiPropertyOptional({
    description:
      "WhatsApp account whose WABA the template is created on. Must belong to the caller's tenant. Omitted ⇒ the tenant's default connected account.",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

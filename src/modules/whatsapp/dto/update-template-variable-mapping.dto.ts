import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Placeholder → data source for the notification pipeline.
 *
 * Both sides are re-validated in `WhatsappTemplateService.setVariableMapping`
 * (key must be a placeholder the template declares; value must be one of the
 * closed `WHATSAPP_TEMPLATE_VARIABLE_SOURCES`). An empty object clears the
 * binding.
 */
export class UpdateTemplateVariableMappingDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { '1': 'patient_name', '2': 'appointment_date' },
  })
  @IsObject()
  mapping!: Record<string, string>;
}

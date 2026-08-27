import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { BillingCycle, CustomCycleUnit } from '../../../entities/enums';

/**
 * Create a subscription plan (super-admin only).
 *
 * Limit fields are optional — an omitted/null limit means UNLIMITED for that
 * resource, which is how Free and Custom/enterprise plans are expressed. A FREE
 * plan is simply `price: 0`; a TRIAL is started per-subscription, not per-plan.
 */
export class CreatePlanDto {
  @ApiProperty({ example: 'Professional' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description: 'Price in major units. 0 = free plan.',
    example: 299,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @ApiProperty({ enum: BillingCycle, example: BillingCycle.MONTHLY })
  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;

  @ApiPropertyOptional({
    description:
      'Cycle length when billingCycle is CUSTOM, e.g. 3 + MONTH = "every 3 months". Required when billingCycle is CUSTOM.',
    example: 3,
  })
  @ValidateIf(
    (o: CreatePlanDto) =>
      o.billingCycle === BillingCycle.CUSTOM || o.customCycleValue !== undefined,
  )
  @IsInt()
  @IsPositive()
  customCycleValue?: number;

  @ApiPropertyOptional({
    enum: CustomCycleUnit,
    description: 'Unit for customCycleValue. Required when billingCycle is CUSTOM.',
    example: CustomCycleUnit.MONTH,
  })
  @ValidateIf(
    (o: CreatePlanDto) =>
      o.billingCycle === BillingCycle.CUSTOM || o.customCycleUnit !== undefined,
  )
  @IsEnum(CustomCycleUnit)
  customCycleUnit?: CustomCycleUnit;

  @ApiPropertyOptional({ description: 'Max branches (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxBranches?: number | null;

  @ApiPropertyOptional({ description: 'Max users (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxUsers?: number | null;

  @ApiPropertyOptional({
    description: 'Max AI tokens / month (null = unlimited).',
    type: 'integer',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxAiTokens?: number | null;

  @ApiPropertyOptional({
    description: 'Max WhatsApp messages / month (null = unlimited).',
    type: 'integer',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxWhatsappMessages?: number | null;

  @ApiPropertyOptional({
    description: 'Max appointments / month (null = unlimited).',
    type: 'integer',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxAppointments?: number | null;

  @ApiPropertyOptional({
    description: 'Max campaigns / month (null = unlimited).',
    type: 'integer',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxCampaigns?: number | null;

  // ── Count-based resource caps ────────────────────────────────────────────
  // These 13 columns have existed on `subscription_plans` since migration
  // 1730002000000 but were unreachable from this DTO, `PlanAdminService` and
  // the admin UI — so they were NULL on every plan row, which every call site
  // reads as "unlimited". Five of them (`customers`, `storageBytes`,
  // `uploadedFiles`, `knowledgeBaseFiles`, `trainingFiles`) are in
  // ENFORCED_RESOURCE_LIMITS, i.e. they DO refuse writes once set — so leaving
  // them unsettable meant a reviewed enforcement decision silently enforced
  // nothing. Exposing them here is what makes those caps configurable, and is a
  // prerequisite for pricing them as add-ons.

  @ApiPropertyOptional({ description: 'Max AI requests / month (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxAiRequests?: number | null;

  @ApiPropertyOptional({ description: 'Max customers/patients (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxCustomers?: number | null;

  @ApiPropertyOptional({ description: 'Max CRM/WhatsApp contacts (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxCrmContacts?: number | null;

  @ApiPropertyOptional({ description: 'Max conversations (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxConversations?: number | null;

  @ApiPropertyOptional({
    description:
      'Max storage in BYTES (null = unlimited). The platform-wide `uploads.tenant_quota_gb` safety cap still applies and the lower of the two binds.',
    type: 'integer',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxStorageBytes?: number | null;

  @ApiPropertyOptional({ description: 'Max uploaded-files storage in BYTES (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxUploadedFiles?: number | null;

  @ApiPropertyOptional({ description: 'Max API calls / month (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxApiCalls?: number | null;

  @ApiPropertyOptional({ description: 'Max emails (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxEmails?: number | null;

  @ApiPropertyOptional({ description: 'Max invoices (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxInvoices?: number | null;

  @ApiPropertyOptional({ description: 'Max payments (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxPayments?: number | null;

  @ApiPropertyOptional({ description: 'Max transactions (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxTransactions?: number | null;

  @ApiPropertyOptional({ description: 'Max AI knowledge-base files (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxKnowledgeBaseFiles?: number | null;

  @ApiPropertyOptional({ description: 'Max AI training files storage in BYTES (null = unlimited).', type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @IsPositive()
  maxTrainingFiles?: number | null;

  @ApiPropertyOptional({
    description:
      'Declares specific NULL limit columns as intentionally unlimited (Phase 0.2). Keys are the same camelCase field names as the limit fields above (e.g. "maxCustomers"); every value must be the literal "unlimited". Replaces the full set on every write — send the complete desired declarations, not a partial patch. A key naming a column that is currently Finite (a number set) is accepted but has no effect until that column is cleared. Editable even on an in-use plan: declaring a NULL limit unlimited documents existing behaviour, it never changes a subscriber\'s effective limit.',
    example: { maxCustomers: 'unlimited' },
  })
  @IsOptional()
  @IsObject()
  limitDeclarations?: Record<string, 'unlimited'>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Custom/bespoke plan flag.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isCustom?: boolean;
}

/**
 * Update a plan. On a plan that already has active subscribers, only `name`,
 * `isActive` and `limitDeclarations` are honoured — economic terms (price,
 * billing cycle, every `maxX` limit, `isCustom`) are immutable (422) to
 * protect existing subscriptions; create a new plan instead. On a plan with
 * no active subscribers, every field is fully editable, including clearing a
 * previously-set limit back to unlimited by sending `null` for it.
 */
export class UpdatePlanDto extends PartialType(CreatePlanDto) {}

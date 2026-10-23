# Data classification

Residency plan section 5. A **technical inventory**: it says which controls apply to which data, not what the law permits (that is `LC`, see `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part E)`).

| Class | Meaning | In the Saudi boundary (target) | May leave |
|---|---|---|---|
| D0 | Public (clinic listing, marketing pages) | no | yes |
| D1 | Internal / infrastructure, anonymous metrics | no | yes, once verified free of identifiers |
| D2 | Personal (patient name, phone, DOB; staff identity) | **yes** | only via a registered processor, minimum data |
| D3 | Sensitive identifiers (national ID / Iqama, insurance number) | **yes** | no by default; never to AI, WhatsApp or e-mail |
| D4 | Health (notes, reports, uploads, health-revealing appointments, related AI and WhatsApp content, embeddings built from them) | **yes** | no by default; any exception needs LC + consent + approved route |
| D5 | Payment (Tap ids, last four, amounts, invoices) | yes (stored) | to Tap only; no card number or CVV ever enters Ziyarati |
| D6 | Authentication / secrets (hashes, tokens, API keys, tenant provider credentials, keys) | **yes** | no |
| D7 | Audit (activity log, platform-admin audit, CloudTrail) | **yes** when it holds identifiers | CloudTrail management events are AWS-side |
| D8 | Operational telemetry (logs, metrics, alarms) | treated as D2/D4 until its payload is verified clean | only after verification |

A table is classified by what it **can** contain, not by what a typical row does, and counts under every class it can hold.

## Where this is enforced

| Mechanism | Where | Test |
|---|---|---|
| One row per table; a new entity without a row fails the build | `src/modules/data-governance/data-classification.ts` | `data-classification.spec.ts` |
| D3 / D4 / D6 are never external by default (`NEVER_EXTERNAL_BY_DEFAULT`) | same file; consumed by the AI minimiser, WhatsApp/e-mail policy and the erasure plan | per-consumer specs |
| Stack-level tag `DataClassification = restricted-health` and `Region` via provider `default_tags` | `infra/terraform/environments/*/main.tf` (`default_tags`) | not asserted by a test (`CV`) |
| Erasure and offboarding cover every table that holds D2/D3/D4 | `subject-erasure.registry.ts`, `tenant-offboarding.plan.ts` | `subject-erasure.registry.spec.ts`, `tenant-offboarding.plan.spec.ts` |

> Not built: the plan's **DPIA support export** (P16, "what data, where, who can access"). The classification file's header refers to a `dpia-inventory.ts` that does not exist yet. This document and the tables below are the interim inventory.

## Summary

<!-- BEGIN GENERATED: classification-summary -->
Tables classified: 161. A table counts under every class it can hold.

| Class | Tables |
| --- | --- |
| D0 | 6 |
| D1 | 57 |
| D2 | 54 |
| D3 | 1 |
| D4 | 19 |
| D5 | 18 |
| D6 | 14 |
| D7 | 5 |
| D8 | 9 |

Never sent outside the boundary by default: D3, D4, D6.
<!-- END GENERATED: classification-summary -->

## Tables

Generated from `data-classification.ts`; regenerate with `UPDATE_COMPLIANCE_DOCS=1 npx jest compliance-docs`.

<!-- BEGIN GENERATED: classification-tables -->
| Table | Classes | Whose data | Purpose |
| --- | --- | --- | --- |
| `ai_agents` | D1 | - | AI agent configuration per tenant |
| `ai_batch_items` | D2, D4 | patient | Items of an OpenAI batch job; carry conversation content |
| `ai_batch_jobs` | D1 | - | OpenAI batch job bookkeeping |
| `ai_conversations` | D2, D4 | patient | AI chat sessions; session JSON holds booking state (names, phones) |
| `ai_cost_logs` | D1 | - | AI spend accounting |
| `ai_execution_metrics` | D1 | - | AI latency and outcome metrics |
| `ai_knowledge_bases` | D1 | - | Clinic-authored knowledge for retrieval |
| `ai_memories` | D2, D4 | patient | Long-term per-patient AI memory; embeddings sit in a sidecar that cascades |
| `ai_messages` | D2, D4 | patient | AI chat transcript |
| `ai_prompts` | D1 | - | Tenant prompt configuration |
| `ai_training_files` | D1 | - | Clinic knowledge uploads |
| `ai_usage_logs` | D1 | - | AI token usage |
| `tenant_ai_deployments` | D6 | - | Per-tenant AI route with an encrypted provider key |
| `analytics_events` | D8 | - | Product analytics events |
| `daily_reports` | D1 | - | Aggregated daily report |
| `monthly_reports` | D1 | - | Aggregated monthly report |
| `dashboard_metrics` | D1 | - | Aggregated dashboard counters |
| `export_jobs` | D2, D4 | patient | Report export jobs; the produced file can hold patient rows |
| `usage_report_schedules` | D2 | staff | Scheduled usage report recipients |
| `appointments` | D2, D4 | patient | Bookings; the service and notes can reveal a condition |
| `appointment_services` | D2 | patient | Services on a booking |
| `appointment_cancellations` | D2, D4 | patient | Cancellation record; reason is free text |
| `appointment_history` | D2 | patient | Booking change history |
| `appointment_notes` | D4 | patient | Staff free-text notes on a booking |
| `appointment_reschedules` | D2 | patient | Reschedule record |
| `appointment_status_logs` | D2 | patient | Booking status transitions |
| `blocked_slots` | D1 | - | Blocked calendar time |
| `calendar_slots` | D1 | - | Calendar slots |
| `holidays` | D1 | - | Clinic holidays |
| `waitlist_entries` | D2 | patient | Waitlist |
| `waitlist_offers` | D2 | patient | Waitlist offers |
| `queue_entries` | D2 | patient | Walk-in queue |
| `patient_action_links` | D6 | patient | Hashed single-use patient action tokens |
| `users` | D2, D6 | staff | Staff accounts and password hashes |
| `patients` | D2, D6 | patient | Patient accounts (marketplace) and password hashes |
| `roles` | D1 | - | Roles |
| `permissions` | D1 | - | Permission catalogue |
| `role_permissions` | D1 | - | Role to permission mapping |
| `user_roles` | D1 | - | User to role mapping |
| `refresh_tokens` | D6 | staff | Hashed refresh tokens |
| `password_resets` | D6 | staff | Hashed password-reset tokens |
| `api_keys` | D6 | clinic | Hashed integration API keys |
| `api_logs` | D8 | staff | API request log; stores client IP |
| `data_subject_requests` | D7 | patient, staff | Data-subject request trail: ids, type, status, counts (no personal data in the row) |
| `deletion_evidence` | D7 | - | Append-only proof of what a deletion touched (no personal data in the row) |
| `audit_logs` | D7 | staff | Clinic activity log |
| `clinical_access_logs` | D7 | patient, staff | Who read which patient record (read-audit) |
| `verification_audit_logs` | D7 | staff | Clinic verification audit |
| `billing_upgrade_requests` | D5 | clinic | Plan upgrade requests |
| `billing_upgrade_request_events` | D5 | clinic | Upgrade request events |
| `invoices` | D5 | patient | Patient invoices |
| `invoice_items` | D5 | patient | Invoice lines |
| `payments` | D2, D5 | patient | Patient payments; metadata and failure text can hold payer details |
| `payment_links` | D5, D6 | patient | Payment link tokens |
| `payment_reconciliation_exceptions` | D5 | - | Reconciliation discrepancies |
| `merchant_accounts` | D5 | clinic | Clinic merchant accounts at the payment provider |
| `refunds` | D5 | patient | Refunds |
| `transactions` | D5 | patient | Ledger transactions |
| `settlements` | D5 | clinic | Payout settlements |
| `settlement_items` | D5 | clinic | Settlement lines |
| `resource_purchases` | D5 | clinic | Add-on purchases |
| `subscriptions` | D5 | clinic | Clinic subscriptions |
| `subscription_invoices` | D5 | clinic | Clinic subscription invoices |
| `subscription_plans` | D1 | - | Plan catalogue |
| `subscription_usage` | D1 | - | Plan usage counters |
| `tenant_payment_methods` | D5 | clinic | Tokenised clinic payment methods (brand, scheme, last four only) |
| `tenant_usage_limit_overrides` | D1 | - | Per-tenant limit overrides |
| `resource_price_catalog` | D1 | - | Add-on price catalogue |
| `resource_price_change_events` | D1 | - | Price catalogue history |
| `staff_commissions` | D5 | staff | Staff commission accounting |
| `campaigns` | D1 | - | Campaign definitions |
| `campaign_runs` | D1 | - | Campaign runs |
| `campaign_recipients` | D2 | patient | Per-recipient campaign delivery; email and failure text |
| `outbox_jobs` | D8 | - | Outbox of side-effects to dispatch |
| `notification_logs` | D2, D8 | patient | WhatsApp / notification delivery log |
| `notification_preferences` | D2 | patient, staff | Channel preferences |
| `notification_rules` | D1 | - | Notification rules |
| `notification_templates` | D1 | - | Notification templates |
| `scheduled_notifications` | D2 | patient | Queued reminders; variables hold recipient details |
| `in_app_notifications` | D2 | staff | Staff inbox |
| `admin_notifications` | D1 | - | Platform operator notices |
| `email_logs` | D2, D8 | patient | Email delivery log; metadata stores the template variables |
| `email_suppressions` | D2 | patient | Suppressed email addresses |
| `conversations` | D2, D4 | patient | Patient conversation threads |
| `conversation_participants` | D2 | patient, staff | Thread participants |
| `messages` | D2, D4 | patient | Conversation messages |
| `message_attachments` | D4 | patient | Message attachments |
| `message_status_logs` | D8 | - | Message delivery status |
| `handover_requests` | D2 | patient | AI to human handover requests |
| `whatsapp_accounts` | D6 | clinic | WhatsApp Business account tokens |
| `whatsapp_contacts` | D2 | patient | WhatsApp contacts |
| `whatsapp_templates` | D1 | - | WhatsApp message templates |
| `whatsapp_webhooks` | D2, D8 | patient | Raw inbound WhatsApp webhook events |
| `customers` | D2, D3, D4 | patient | The patient record: identity, contact, national ID, chronic-disease intake |
| `customer_addresses` | D2 | patient | Patient addresses |
| `customer_profiles` | D4 | patient | Medical history, allergies, blood type, emergency contact |
| `customer_notes` | D4 | patient | Staff notes on a patient |
| `customer_files` | D4 | patient | Patient documents (objects in storage) |
| `customer_reviews` | D2 | patient | Patient reviews |
| `customer_segments` | D1 | - | Segment definitions |
| `customer_tag_relations` | D2 | patient | Tags applied to a patient |
| `customer_tags` | D1 | - | Tag definitions |
| `clinical_encounters` | D4 | patient | Clinical encounters |
| `clinical_entries` | D4 | patient | Clinical entries (diagnosis, prescription, results, ...) |
| `clinical_entry_revisions` | D4 | patient | Clinical entry revision history |
| `file_uploads` | D4 | patient, staff | Uploaded file metadata |
| `staff_ratings` | D2 | patient | Patient ratings of staff; comment is free text |
| `integration_connections` | D6 | clinic | Encrypted connections to a clinic PMS |
| `integration_conflicts` | D2 | patient | Sync conflicts between systems |
| `integration_id_map` | D2 | patient | External id mapping |
| `integration_idempotency_keys` | D1 | - | Idempotency keys |
| `integration_import_items` | D2 | patient | Excel import rows |
| `integration_import_jobs` | D2 | patient | Excel import jobs |
| `integration_inbound_events` | D2 | patient | Inbound partner events |
| `integration_oauth_states` | D6 | clinic | OAuth state values |
| `integration_staff_provisioning` | D2 | staff | Staff provisioning from a PMS |
| `integration_sync_jobs` | D1 | - | Sync job bookkeeping |
| `integration_webhook_endpoints` | D6 | clinic | Inbound partner endpoints and secrets |
| `webhook_endpoints` | D6 | clinic | Outbound webhook endpoints and secrets |
| `webhook_deliveries` | D2, D8 | patient | Outbound webhook delivery payloads |
| `webhook_logs` | D8 | - | Webhook log |
| `services` | D1 | - | Clinic service catalogue |
| `service_categories` | D1 | - | Service categories |
| `service_prices` | D1 | - | Service prices |
| `service_resources` | D1 | - | Service resources |
| `specialties` | D0 | - | Specialty lookup |
| `staff_profiles` | D2 | staff | Staff profiles |
| `staff_schedules` | D1 | - | Staff schedules |
| `staff_services` | D1 | - | Staff to service mapping |
| `staff_specialties` | D1 | - | Staff to specialty mapping |
| `staff_time_off` | D2 | staff | Staff time off |
| `working_hours` | D1 | - | Working hours |
| `branches` | D1 | - | Clinic branches |
| `branch_users` | D2 | staff | Staff to branch assignment |
| `tenants` | D1, D2 | clinic | Clinic account and contact details |
| `tenant_settings` | D1 | - | Clinic settings |
| `tenant_specialties` | D1 | - | Clinic specialties |
| `tenant_targets` | D1 | - | Monthly clinic / branch appointment and revenue goals (numeric, no personal data) |
| `tenant_target_history` | D1, D2 | staff | Append-only ledger of target changes; stores the acting staff user id |
| `tenant_approval_events` | D1 | - | Clinic approval history |
| `tenant_verification_documents` | D2 | clinic | Clinic licence documents |
| `feature_definitions` | D1 | - | Feature catalogue |
| `feature_dependencies` | D1 | - | Feature dependencies |
| `feature_flags` | D1 | - | Per-tenant feature flags |
| `feature_plans` | D1 | - | Feature to plan mapping |
| `system_settings` | D1, D6 | - | Platform settings; may hold secrets |
| `support_tickets` | D2 | staff, patient | Support tickets; free text can mention a patient |
| `contact_leads` | D2 | clinic | Website Contact Us enquiries from prospective clinics (name, email, phone, facility, free-text message); no tenant yet |
| `support_ticket_events` | D2 | staff, patient | Support ticket events |
| `sales_activities` | D2 | staff | Sales staff activity |
| `sales_bonus_records` | D5 | staff | Sales bonus accounting |
| `sales_clinic_assignments` | D1 | - | Sales assignment |
| `sales_target_revisions` | D1 | - | Sales target history |
| `sales_targets` | D1 | - | Sales targets |
| `workflows` | D1 | - | Workflow definitions |
| `workflow_runs` | D2 | patient | Workflow runs; context carries the triggering record |
| `cities` | D0 | - | City lookup |
| `countries` | D0 | - | Country lookup |
| `currencies` | D0 | - | Currency lookup |
| `languages` | D0 | - | Language lookup |
| `timezones` | D0 | - | Timezone lookup |
<!-- END GENERATED: classification-tables -->

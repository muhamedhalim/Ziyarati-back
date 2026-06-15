# 04 — API Reference (every endpoint → UI usage)

Complete catalog from the controllers. Paths are relative to the global prefix (`/api/v1`).
`Perm` = required permission slug; `Role` = `@Roles`; `Public` = no auth. All list endpoints take
`page,limit` (+ filters noted). Tenant is always derived server-side.

Legend for "Used in": the screen/component (see `05-screens-and-flows.md`).

## Auth (`/auth`) — `auth.controller.ts`
| Verb | Path | Gate | Body DTO | Used in |
|---|---|---|---|---|
| POST | /auth/register-owner | Public | RegisterOwnerDto | Clinic sign-up |
| POST | /auth/register-user | `users.manage` | RegisterUserDto (roleSlug ∈ manager/receptionist) | Settings ▸ Users ▸ Invite |
| POST | /auth/register-patient | Public | RegisterPatientDto | Patient sign-up (portal) |
| POST | /auth/login | Public | LoginDto (email, password, tenantSlug?) | Login |
| POST | /auth/refresh | Public | RefreshTokenDto | Silent token rotation |
| POST | /auth/logout | Public | RefreshTokenDto | Logout |
| POST | /auth/forgot-password | Public | ForgotPasswordDto | Forgot password |
| POST | /auth/reset-password | Public | ResetPasswordDto | Reset password |
| POST | /auth/change-password | auth | ChangePasswordDto | Settings ▸ Profile |
| GET | /auth/me | auth | — | App bootstrap (permissions, principal) |
| POST | /auth/logout-all | auth | — | Settings ▸ Profile ▸ Sign out everywhere |

## Roles & Permissions (`/roles`, `/permissions`) — `roles.controller.ts`, `permissions.controller.ts`
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST/GET/GET:id/PATCH:id/DELETE:id | /roles | `roles.manage` | Settings ▸ Roles |
| PUT | /roles/:id/permissions | `roles.manage` | Role permission editor (SetRolePermissionsDto) |
| POST | /roles/:id/users/:userId | `roles.manage` | Assign role to user |
| DELETE | /roles/:id/users/:userId | `roles.manage` | Remove role from user |
| GET | /roles/users/:userId | `roles.manage` | User's roles (Users screen) |
| GET | /permissions | `roles.manage` | Permission picker (role editor) |
| POST/PATCH:id/DELETE:id | /permissions | `@Roles(super_admin)` | Platform ▸ Permissions catalogue |
| GET | /permissions/:id | `roles.manage` | Permission detail |

## Tenants (`/tenants`) — `tenant.controller.ts`
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /tenants | super_admin | Platform ▸ Tenants ▸ Create |
| GET | /tenants | super_admin | Platform ▸ Tenants list (filters: status, search) |
| GET | /tenants/me | auth (tenant) | App bootstrap — clinic profile + **active gate** |
| PATCH | /tenants/me | owner | Settings ▸ Clinic profile |
| GET | /tenants/me/settings | auth (tenant) | Settings ▸ Operations (read) |
| PATCH | /tenants/me/settings | owner, manager | Settings ▸ Operations (write) |
| GET | /tenants/:id | super_admin | Platform ▸ Tenant detail |
| PATCH | /tenants/:id | super_admin | Platform ▸ Tenant detail edit |
| POST | /tenants/:id/approve | super_admin | Approve action (ApprovalActionDto: reason?) |
| POST | /tenants/:id/reject | super_admin | Reject action |
| POST | /tenants/:id/suspend | super_admin | Suspend action |
| GET | /tenants/:id/approval-events | super_admin | Tenant detail ▸ Approval history |

## Branches (`/branches`) — `branch.controller.ts`
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /branches | owner, manager | Settings ▸ Branches ▸ Create |
| GET / GET:id | /branches | auth (tenant) | Branch list / detail; branch pickers everywhere |
| PATCH:id | /branches | owner, manager | Edit branch |
| DELETE:id | /branches | owner | Delete branch |

## Verification documents (`/verification-documents`) — `tenant-verification.controller.ts`
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /verification-documents/me | owner | Settings ▸ Verification ▸ Upload (CreateVerificationDocumentDto: docType, fileUrl) |
| GET | /verification-documents/me | owner, manager | Settings ▸ Verification (status list) |
| GET | /verification-documents/tenants/:tenantId | super_admin | Platform ▸ Verification queue (per tenant) |
| PATCH | /verification-documents/:documentId/review | super_admin | Approve/Reject a doc (ReviewVerificationDocumentDto) |

## Appointments (`/appointments`) — `appointment.controller.ts` (+ ActiveTenantGuard)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /appointments | `appointments.create` | Booking modal / portal book |
| GET | /appointments | `appointments.read` | Appointment list + calendar (filters: status, branchId, staffId, customerId, from, to) |
| GET | /appointments/:id | `appointments.read` | Appointment drawer/detail |
| PATCH | /appointments/:id | `appointments.update` | Detail ▸ reassign staff/branch/notes |
| PUT | /appointments/:id/services | `appointments.update` | Detail ▸ edit services (recomputes total/end) |
| POST | /appointments/:id/status | `appointments.update` | Status stepper (state machine) |
| POST | /appointments/:id/cancel | `appointments.cancel` | Cancel modal (reason, refundAmount) |
| POST | /appointments/:id/reschedule | `appointments.reschedule` | Reschedule modal |
| POST | /appointments/:id/notes | `appointments.update` | Detail ▸ Notes |
| GET | /appointments/:id/notes | `appointments.read` | Detail ▸ Notes |
| GET | /appointments/:id/timeline | `appointments.read` | Detail ▸ Timeline feed |
| DELETE | /appointments/:id | `appointments.manage_all` | Delete (only CANCELLED/NO_SHOW) |
| POST | /appointments/:id/review | `reviews.create` | Portal ▸ leave review |
| GET | /appointments/:id/review | `reviews.read` | Detail ▸ Review |

## Reviews (`/reviews`) — `review.controller.ts`
| Verb | Path | Gate | Used in |
|---|---|---|---|
| GET | /reviews | `reviews.read` | Reviews inbox (filters: customerId, minRating) |
| POST | /reviews/:id/reply | `reviews.manage` | Reply to review |

## CRM
**Customers** (`/crm/customers`) — `customer.controller.ts`
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /crm/customers | `crm.customers.manage` | Customer create |
| GET | /crm/customers | `crm.customers.read` | Customer list (isActive) |
| GET | /crm/customers/search | `crm.customers.read` | Search (q, tagIds[], isActive) — pickers + list search |
| GET | /crm/customers/:id | `crm.customers.read` | Customer profile |
| PATCH | /crm/customers/:id | `crm.customers.manage` | Edit customer |
| DELETE | /crm/customers/:id | `crm.customers.manage` | Delete customer |

**Profile** `/crm/customers/:customerId/profile` — GET `crm.customers.read`, PUT `crm.customers.manage` (medical history/allergies/blood type/emergency contact) — Profile ▸ Medical.

**Addresses** `/crm/customers/:customerId/addresses` — POST/PATCH:id/DELETE:id `crm.customers.manage`, GET `crm.customers.read` — Profile ▸ Addresses.

**Notes** `/crm/customers/:customerId/notes` — POST/PATCH:id/DELETE:id `crm.notes.manage`, GET `crm.notes.read` — Profile ▸ Notes.

**Files** `/crm/customers/:customerId/files` — POST/DELETE:id `crm.files.manage`, GET/GET:id `crm.files.read` — Profile ▸ Files.

**Tags catalogue** `/crm/tags` — POST/PATCH:id/DELETE:id `crm.tags.manage`, GET `crm.tags.read` (filter q) — CRM ▸ Tags.

**Tag relations** `/crm/customers/:customerId/tags` — POST/DELETE:tagId `crm.tags.manage`, GET `crm.tags.read` — Profile ▸ Tags.

## Scheduling (`/scheduling/*`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| C/R/R:id/U:id/D:id | /scheduling/slots | manage/read (`scheduling.slots.*`) | Scheduling ▸ Slots (filters branchId, staffId, isAvailable, from, to, sort) |
| POST | /scheduling/slots/:id/enable · /disable | `scheduling.slots.manage` | Slot enable/disable |
| C/R/R:id/U:id/D:id | /scheduling/blocked-slots | `scheduling.blocked.*` | Scheduling ▸ Blocked (branchId, staffId, from, to) |
| C/R/R:id/U:id/D:id | /scheduling/holidays | `scheduling.holidays.*` | Scheduling ▸ Holidays (branchId, isRecurring, from, to) |
| GET | /scheduling/availability/check | `scheduling.availability.read` | Booking — is window free? (branchId, staffId, startTime, endTime) |
| GET | /scheduling/availability/windows | `scheduling.availability.read` | Booking — free windows for a day (branchId, staffId, date, slotMinutes) |
| GET | /scheduling/availability/summary | `scheduling.availability.read` | Day summary (branchId, date, staffId?) |
| GET | /scheduling/availability/validate | `scheduling.availability.read` | Pre-submit validation |

## Staff (`/staff`, `/working-hours`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /staff | `staff.create` | Staff create (links existing user → profile) |
| GET | /staff | `staff.read` | Staff list (search, isAvailable, branchId) |
| GET | /staff/availability | `staff.read` | "Bookable staff at branch on date" (branchId, date) — booking + portal |
| GET | /staff/:id | `staff.read` | Staff detail |
| PATCH | /staff/:id | `staff.update` | Edit staff |
| POST | /staff/:id/activate · /deactivate | `staff.update` | Toggle bookable |
| DELETE | /staff/:id | `staff.manage` | Remove staff |
| PUT/GET | /staff/:id/services | update/read | Detail ▸ Services (AssignServicesDto) |
| PUT/GET | /staff/:id/branches | update/read | Detail ▸ Branches (AssignBranchesDto) |
| POST/GET | /staff/:id/schedules | schedule.manage/read | Detail ▸ Schedules |
| PATCH/DELETE | /staff/:id/schedules/:scheduleId | `staff.schedule.manage` | Edit/remove schedule |
| POST/GET | /staff/:id/time-off | timeoff.manage/read | Detail ▸ Time off |
| DELETE | /staff/:id/time-off/:timeOffId | `staff.timeoff.manage` | Remove time off |
| POST/GET | /staff/:id/commissions | manage/commission.read | Detail ▸ Commissions |
| GET | /staff/:id/commissions/summary | `staff.commission.read` | Commission summary (from, to) |
| POST/GET | /staff/:id/ratings | manage/rating.read | Detail ▸ Ratings |
| C/R/U:id/D:id | /working-hours | schedule.manage / `staff.read` | Staff ▸ Working hours grid |

## Conversations (`/conversations`, `/conversation-analytics`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /conversations | `conversations.manage` | New conversation |
| POST | /conversations/bulk-message | `messages.send` | Inbox ▸ bulk message (BulkMessageDto) |
| GET | /conversations | `conversations.read` | Inbox list (status, type, assignedToUserId, customerId, branchId, participantUserId, from, to) |
| GET | /conversations/:id | `conversations.read` | Thread header |
| PATCH | /conversations/:id | `conversations.manage` | Edit conversation |
| POST | /conversations/:id/assign | `conversations.manage` | Assign agent |
| POST | /conversations/:id/archive · /unarchive | `conversations.manage` | Archive toggle |
| DELETE | /conversations/:id | `conversations.manage` | Delete (hard) |
| POST | /conversations/:conversationId/messages | `messages.send` | Composer |
| GET | /conversations/:conversationId/messages | `messages.read` | Thread messages (senderType, messageType, from, to) |
| GET | /…/messages/:messageId | `messages.read` | Message detail |
| PATCH | /…/messages/:messageId | `messages.send` | Edit message |
| POST | /…/messages/:messageId/read | `messages.read` | Mark read |
| DELETE | /…/messages/:messageId | `messages.send` | Delete message |
| C/R/U/D | /conversations/:conversationId/participants | `participants.manage` (GET too) | Thread ▸ participants |
| POST/GET/DELETE | /messages/:messageId/attachments | attachments.manage / `messages.read` | Attachments + download |
| GET | /conversation-analytics/overview·messages·agents·response-time | `analytics.read` | Conversations ▸ Analytics |

## WhatsApp (`/whatsapp/*`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| C/R/R:id/PATCH:id/D:id | /whatsapp/accounts | accounts.manage / accounts.read | WhatsApp ▸ Accounts (branchId, isActive) |
| GET | /whatsapp/accounts/:id/connection-status | `whatsapp.accounts.read` | Account ▸ connection badge |
| POST | /whatsapp/accounts/:id/activate · /deactivate | `whatsapp.accounts.manage` | Account toggle |
| C/R/R:id/PATCH:id/D:id | /whatsapp/templates | templates.manage / templates.read | Templates (status, category, language, search) |
| PATCH | /whatsapp/templates/:id/status | `whatsapp.templates.manage` | Template review status |
| POST | /whatsapp/templates/:id/send | `whatsapp.send` | Send template (SendTemplateMessageDto) |
| POST | /whatsapp/templates/:id/schedule | `whatsapp.send` | Schedule template send |
| C/R/R:id/PATCH:id/D:id | /whatsapp/contacts | contacts.manage / contacts.read | Contacts (search, customerId, hasCustomer) |
| POST | /whatsapp/contacts/bulk-import | `whatsapp.contacts.manage` | Bulk import |
| C/R/R:id/PATCH:id | /whatsapp/webhooks | `whatsapp.webhooks.manage` | Webhooks admin |
| POST | /whatsapp/webhooks/:id/retry | `whatsapp.webhooks.manage` | Retry webhook |
| GET | /whatsapp/webhooks/verify · POST /events | **Public** | Meta webhook (server-only) |
| GET | /whatsapp/analytics/overview·templates·engagement·accounts | `whatsapp.analytics.read` | WhatsApp ▸ Analytics (from, to, templateId) |

## AI (`/ai/*`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| C/R/R:id/PATCH:id/D:id | /ai/agents | agents.manage / agents.read | AI ▸ Agents (search, model, isActive) |
| POST | /ai/agents/:id/activate · /deactivate | `ai.agents.manage` | Agent toggle |
| C/R/R:id/PATCH:id/D:id | /ai/knowledge-bases | knowledge.manage / knowledge.read | KB chunks (agentId, search) |
| POST | /ai/knowledge-bases/rebuild | `ai.knowledge.manage` | Rebuild index |
| C/R/R:id/PATCH:id/D:id | /ai/training-files | training.manage / training.read | Training files (agentId, status) |
| POST | /ai/training-files/:id/process · /reprocess | `ai.training.manage` | (Re)ingest file |
| C/R/R:id/PATCH:id/D:id | /ai/prompts | prompts.manage / prompts.read | Prompts (agentId, search, isActive) |
| POST | /ai/prompts/:id/activate · /deactivate | `ai.prompts.manage` | Prompt toggle |
| POST/GET/GET:id | /ai/conversations | conv.manage / conv.read | AI conversations (status, agentId) |
| POST/GET | /ai/conversations/:id/messages | conv.manage / conv.read | AI thread |
| POST | /ai/conversations/:id/close · /archive | `ai.conversations.manage` | Close/archive |
| POST/GET/GET:id/PATCH:id | /ai/handovers | handover.manage / handover.read | Handover queue (status, assignedToUserId) |
| POST | /ai/handovers/:id/assign·accept·resolve·reject | `ai.handover.manage` | Handover actions |
| GET | /ai/analytics/usage·cost·conversations·agents·knowledge | `ai.analytics.read` | AI ▸ Analytics (from, to) |

## Campaigns (`/campaigns`, `/campaign-analytics`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /campaigns | `campaigns.manage` | Campaign create (DRAFT) |
| GET | /campaigns | `campaigns.read` | Campaign list (status, type, search, includeArchived, sortBy, sortOrder) |
| GET | /campaigns/:id | `campaigns.read` | Campaign detail |
| PATCH/DELETE | /campaigns/:id | `campaigns.manage` | Edit/delete |
| POST | /campaigns/:id/archive·duplicate·schedule·launch·pause·resume·cancel·retry | `campaigns.manage` | Lifecycle controls |
| POST/GET/DELETE | /campaigns/:campaignId/recipients | recipients.manage / recipients.read | Detail ▸ Recipients (status, customerId) |
| GET | /campaigns/:campaignId/recipients/statistics | `campaign_recipients.read` | Recipients stats |
| GET | /campaign-analytics/dashboard·statistics·history·campaigns/:id/performance | `campaign_analytics.read` | Campaigns ▸ Analytics |

## Notifications (`/notification-*`, `/scheduled-notifications`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| C/R/R:id/PATCH:id/D:id | /notification-templates | templates.manage / templates.read | Notifications ▸ Templates (search, type, channel, isActive) |
| POST | /notification-templates/:id/activate · /deactivate | `notification_templates.manage` | Template toggle |
| C/R/R:id/PATCH:id/D:id | /notification-rules | rules.manage / rules.read | Notifications ▸ Rules (triggerEvent, templateId, isActive) |
| POST | /notification-rules/:id/enable · /disable | `notification_rules.manage` | Rule toggle |
| C/R/R:id/PATCH:id | /scheduled-notifications | notifications.manage / notifications.read | Scheduled (status, templateId, appointmentId, recipientType, recipientId, from, to) |
| POST | /scheduled-notifications/:id/cancel·reschedule·retry | `notifications.manage` | Scheduled actions |
| GET | /notification-logs · /statistics · /:id | `notifications.read` | Notifications ▸ Logs (status, channel, templateId, recipientType, recipientId, from, to) |

## Payments (owner) (`/payments`, `/invoices`, `/refunds`, `/transactions`, `/settlements`, `/payment-links`, `/payment-gateways`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /payments | `payments.manage` | Collect payment |
| POST | /payments/:id/confirm | `payments.manage` | Confirm payment (ConfirmPaymentDto) |
| GET | /payments/:id/status | `payments.read` | Payment status poll |
| GET | /payments · /:id | `payments.read` | Payments list/detail (status, settlementStatus, customerId, from, to) |
| POST/GET/GET:id | /invoices (+ /:id/items, /:id/finalize) | invoices.manage / invoices.read | Invoices (status, customerId, from, to) |
| POST/GET/GET:id | /refunds | refunds.manage(POST) / payments.read(GET) | Refunds (paymentId, status) |
| GET/GET:id | /transactions | `payments.read` | Gateway transactions (paymentId, type, status) |
| POST | /settlements/generate | `settlements.manage` | Generate settlement batch |
| GET/GET:id | /settlements | `settlements.read` | Settlements (status, from, to) |
| POST/GET/GET:id | /payment-links (+ /:id/disable) | payments.manage / payments.read | Payment links (status) |
| GET | /payment-links/token/:token | `payments.read` | Resolve link by token |
| GET/POST/GET:id/PATCH:id | /payment-gateways | `@Roles(super_admin)` | Platform ▸ Payment gateways |
| POST | /payments/webhooks/moyasar | **Public** | Gateway webhook (server-only) |

## Subscription & Billing (`/subscriptions`, `/billing`, `/usage`, `/feature-flags`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| GET | /subscriptions/plans · /plans/:id | `subscription.read` | Billing ▸ Plans |
| POST | /subscriptions | `subscription.manage` | Subscribe (CreateSubscriptionDto) |
| GET | /subscriptions/current | `subscription.read` | Billing ▸ Current plan |
| POST | /subscriptions/change-plan·cancel·reactivate | `subscription.manage` | Plan lifecycle |
| GET | /billing/invoices · /summary · /invoices/:id | `billing.read` | Billing ▸ Invoices |
| POST | /billing/invoices/:id/pay | `billing.manage` | Pay SaaS invoice |
| GET | /usage · /breakdown | `usage.read` | Billing ▸ Usage (periodMonth) |
| GET | /feature-flags · /check | `featureflag.read` | Billing ▸ Feature flags |
| PUT | /feature-flags | `featureflag.manage` | Edit flag (**super_admin only effective**) |

## Analytics (`/analytics/*`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| POST | /analytics/events | `analytics.events.manage` | (server/client event tracking) |
| GET | /analytics/events | `analytics.events.read` | Analytics ▸ Events (eventType, entityType, branchId, from, to) |
| GET | /analytics/dashboard | `analytics.dashboard.read` | Analytics ▸ Dashboard (metricKey?) |
| POST | /analytics/dashboard/refresh | `analytics.reports.manage` | Dashboard ▸ Refresh |
| POST | /analytics/reports/daily/generate | `analytics.reports.manage` | Reports ▸ generate daily |
| GET | /analytics/reports/daily · /:id | `analytics.reports.read` | Daily reports (branchId, from, to) |
| POST | /analytics/reports/monthly/generate | `analytics.reports.manage` | Reports ▸ generate monthly |
| GET | /analytics/reports/monthly · /:id | `analytics.reports.read` | Monthly reports (branchId, month) |

## Platform (`/platform/*`)
| Verb | Path | Gate | Used in |
|---|---|---|---|
| C/R/R:id | /platform/api-keys (+ /:id/rotate·revoke·activate·deactivate) | api-keys.manage / api-keys.read | Settings ▸ API keys |
| GET/GET stats/GET:id | /platform/api-logs | `platform.api-logs.read` | Developer ▸ API logs (endpoint, method, statusCode, from, to, sort) |
| GET/GET:id/POST:id retry | /platform/webhook-logs | webhooks.read / webhooks.manage | Developer ▸ Webhook logs (source, eventType, status, from, to) |
| C/R/R usage/R:id/D:id | /platform/files | files.manage / files.read | Settings ▸ Files (fileType) |
| C/R/R:id/PATCH:id/D:id | /platform/settings | `@Roles(super_admin)` | Platform ▸ System settings (key) |

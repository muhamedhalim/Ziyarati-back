/**
 * FR-031 — the checked-in reference set for the tenant-enforcement invariant
 * (`route-authorization.spec.ts`, T023). Data, not code, mirroring the same
 * pattern FR-030 already establishes for `public-routes.allowlist.json`:
 * a deliberately-reviewed snapshot, not something the invariant derives from
 * itself (deriving "expected tenant-scoped controllers" from the same live
 * run being checked would be circular — a controller that silently lost
 * `ActiveTenantGuard` would just as silently drop out of both the "expected"
 * and "actual" sets, and the invariant would never see a mismatch).
 *
 * **Definition applied**: a controller is tenant-scoped if, in the current
 * codebase, every one of its routes that is NOT genuinely open (i.e.
 * excluding routes that are `isPublic` and NOT `isApiKeyRoute` — a
 * `@Public()`-only route has no principal and nothing to scope; an
 * `@ApiKeyProtected()` route IS `isPublic` from JwtAuthGuard's perspective
 * but is authenticated by API key and IS tenant-scoped via a different
 * path) carries `ActiveTenantGuard` in its effective guard set (global ∪
 * controller ∪ method).
 *
 * **Generated once, from real framework metadata, reviewed before commit —
 * never by reading source text.** Produced by running the real
 * `collectRoutes()` harness (the same one this invariant itself uses)
 * against the full, unmodified `AppModule` graph and keeping only the
 * controllers where 100% of in-scope routes carried the guard (0 "mixed"
 * controllers were found — every controller in the app is either cleanly
 * tenant-scoped or not tenant-scoped at all today, so no edge case needed
 * manual adjudication). 86 of 125 mounted controllers qualified.
 *
 * Growing this list is a deliberate edit, exactly like the public-route
 * allow-list: a new tenant-business controller that should enforce
 * `ActiveTenantGuard` is added here on purpose, not auto-discovered.
 */
export const TENANT_SCOPED_CONTROLLERS: readonly string[] = [
  'AiAgentController',
  'AiAnalyticsController',
  'AiConversationController',
  'AiKnowledgeBaseController',
  'AiMemoryController',
  'AiMetricsController',
  'AiOrchestratorController',
  'AiPromptController',
  'AiToolCatalogController',
  'AiTrainingFileController',
  'AnalyticsEventController',
  'ApiKeyController',
  'ApiLogController',
  'AppointmentController',
  'AvailabilityController',
  'BlockedSlotController',
  'BranchController',
  'CalendarSlotController',
  'CampaignAnalyticsController',
  'CampaignController',
  'CampaignRecipientController',
  'ConversationAnalyticsController',
  'ConversationController',
  'ConversationParticipantController',
  'CustomerAddressController',
  'CustomerController',
  'CustomerFileController',
  'CustomerNoteController',
  'CustomerProfileController',
  'CustomerTagController',
  'CustomerTagRelationController',
  'DailyReportController',
  'DashboardController',
  'FileUploadController',
  'HandoverChatController',
  'HandoverRequestController',
  'HolidayController',
  'IntegrationAppointmentsController',
  'IntegrationAvailabilityController',
  'IntegrationConflictsController',
  'IntegrationConnectionController',
  'IntegrationCustomersController',
  'IntegrationImportJobsController',
  'IntegrationImportsController',
  'IntegrationInboundEndpointsController',
  'IntegrationMappingsController',
  'IntegrationOAuthController',
  'IntegrationServicesController',
  'IntegrationStaffController',
  'IntegrationStaffProvisioningController',
  'IntegrationSyncController',
  'IntegrationWriteAppointmentsController',
  'IntegrationWriteCustomersController',
  'IntegrationWriteServicesController',
  'IntegrationWriteStaffController',
  'InvoiceController',
  'MerchantAccountController',
  'MessageAttachmentController',
  'MessageController',
  'MonthlyReportController',
  'NotificationLogController',
  'NotificationRuleController',
  'NotificationSchedulerController',
  'NotificationTemplateController',
  'PaymentController',
  'PaymentLinkController',
  'RecipientDeliveryController',
  'RefundController',
  'ReviewController',
  'ServiceCategoryController',
  'ServiceController',
  'SettlementController',
  'StaffController',
  'SupportTicketController',
  'TransactionController',
  'WebhookDeliveryController',
  'WebhookEndpointController',
  'WebhookLogController',
  'WhatsappAccountController',
  'WhatsappAnalyticsController',
  'WhatsappContactController',
  'WhatsappOnboardingController',
  'WhatsappTemplateController',
  'WhatsappWebhookController',
  'WorkflowController',
  'WorkingHoursController',
];

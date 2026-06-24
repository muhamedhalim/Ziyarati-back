
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- booking exclusion constraint
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy search
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector: RAG embeddings

-- =============================== ENUMS ===============================
CREATE TYPE tenant_approval_status AS ENUM ('PENDING_VERIFICATION','PENDING_APPROVAL','APPROVED','REJECTED','SUSPENDED');
CREATE TYPE verification_doc_status AS ENUM ('PENDING','APPROVED','REJECTED');
CREATE TYPE pricing_type        AS ENUM ('FIXED','VARIABLE');
CREATE TYPE appointment_status  AS ENUM ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW','RESCHEDULED');
CREATE TYPE appointment_source  AS ENUM ('PLATFORM','WHATSAPP_BOT','MANUAL');
CREATE TYPE billing_cycle       AS ENUM ('MONTHLY','YEARLY','CUSTOM');
CREATE TYPE subscription_status AS ENUM ('TRIAL','ACTIVE','PAST_DUE','CANCELLED','SUSPENDED');
CREATE TYPE invoice_status      AS ENUM ('DRAFT','OPEN','PAID','VOID','UNCOLLECTIBLE','REFUNDED');
CREATE TYPE payment_status      AS ENUM ('PENDING','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED');
CREATE TYPE settlement_status_t AS ENUM ('UNSETTLED','IN_BATCH','SETTLED');
CREATE TYPE payout_status       AS ENUM ('PENDING','PROCESSING','PAID','FAILED');
CREATE TYPE conversation_status AS ENUM ('OPEN','BOT','HUMAN','CLOSED');
CREATE TYPE campaign_type       AS ENUM ('BIRTHDAY','HOLIDAY','REACTIVATION','PROMOTION','CUSTOM');
CREATE TYPE campaign_status     AS ENUM ('DRAFT','SCHEDULED','RUNNING','PAUSED','COMPLETED','CANCELLED');
CREATE TYPE recipient_status    AS ENUM ('QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED');
CREATE TYPE handover_status     AS ENUM ('PENDING','ASSIGNED','RESOLVED','CANCELLED');
CREATE TYPE notification_status AS ENUM ('SCHEDULED','SENT','FAILED','CANCELLED');
CREATE TYPE msg_sender_type     AS ENUM ('CUSTOMER','AGENT','BOT','SYSTEM');

-- ============== REFERENCE / LOOKUP (from external) ===================
CREATE TABLE countries (
  id smallint PRIMARY KEY,
  name_ar varchar(100), name_en varchar(100), code varchar(3) UNIQUE
);
CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id smallint NOT NULL REFERENCES countries(id),
  name_ar varchar(100), name_en varchar(100)
);
CREATE TABLE languages (
  id smallint PRIMARY KEY,
  name varchar(50), code varchar(10) UNIQUE, is_rtl boolean NOT NULL DEFAULT false
);
CREATE TABLE currencies (
  id smallint PRIMARY KEY,
  name varchar(50), code varchar(10) UNIQUE, symbol varchar(5)
);
CREATE TABLE timezones (
  id smallint PRIMARY KEY,
  name varchar(100) UNIQUE, "offset" varchar(10)
);

-- ========================= TENANT MANAGEMENT =========================
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  slug varchar(100) NOT NULL UNIQUE,
  logo_url text,
  -- merged-in verification/approval (from internal design) ---------------
  commercial_registration_number varchar(100),
  legal_name varchar(255),
  contact_email varchar(255),
  contact_phone varchar(30),
  country_id smallint REFERENCES countries(id),
  default_currency char(3) NOT NULL DEFAULT 'USD',
  default_timezone varchar(64) NOT NULL DEFAULT 'UTC',
  approval_status tenant_approval_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX uq_tenant_crn ON tenants(commercial_registration_number)
  WHERE commercial_registration_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_tenant_status ON tenants(approval_status) WHERE deleted_at IS NULL;

CREATE TABLE tenant_verification_documents (     -- ADDED (external gap)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  doc_type varchar(80) NOT NULL,            -- CR / license / national_id ...
  file_url text NOT NULL,
  status verification_doc_status NOT NULL DEFAULT 'PENDING',
  reviewed_by uuid,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX ix_verif_tenant ON tenant_verification_documents(tenant_id);

CREATE TABLE tenant_approval_events (            -- ADDED (external gap)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  action varchar(20) NOT NULL CHECK (action IN ('VERIFY','APPROVE','REJECT','SUSPEND','REACTIVATE')),
  reason text,
  acted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_approval_tenant ON tenant_approval_events(tenant_id, created_at);

CREATE TABLE tenant_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
  booking_confirmation varchar(20) NOT NULL DEFAULT 'AUTO',  -- AUTO/MANUAL
  payment_required boolean NOT NULL DEFAULT true,
  cancellation_hours int NOT NULL DEFAULT 24,
  feedback_delay_minutes int NOT NULL DEFAULT 360,           -- +6h feedback
  default_language varchar(10) NOT NULL DEFAULT 'ar',
  currency varchar(10) NOT NULL DEFAULT 'USD',
  bot_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(255) NOT NULL,
  address text,
  city_id uuid REFERENCES cities(id),
  phone varchar(20),
  whatsapp_phone varchar(20),
  timezone varchar(100) NOT NULL DEFAULT 'UTC',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX ix_branch_tenant ON branches(tenant_id, is_active) WHERE deleted_at IS NULL;

-- ===================== SUBSCRIPTIONS / BILLING =======================
CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  price numeric(14,2) NOT NULL,
  billing_cycle billing_cycle NOT NULL,
  max_branches int, max_users int,
  max_ai_tokens bigint, max_whatsapp_messages int,
  max_appointments int,         -- ADDED (req #13)
  max_campaigns int,            -- ADDED (req #13)
  is_active boolean NOT NULL DEFAULT true,
  is_custom boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status subscription_status NOT NULL DEFAULT 'TRIAL',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  auto_renew boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX uq_active_sub ON subscriptions(tenant_id)
  WHERE status IN ('TRIAL','ACTIVE','PAST_DUE') AND deleted_at IS NULL;

CREATE TABLE subscription_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  period_month varchar(7) NOT NULL,            -- YYYY-MM
  ai_tokens_used bigint NOT NULL DEFAULT 0,
  whatsapp_messages_used int NOT NULL DEFAULT 0,
  appointments_used int NOT NULL DEFAULT 0,    -- ADDED
  campaigns_used int NOT NULL DEFAULT 0,       -- ADDED
  updated_at timestamptz,
  UNIQUE (subscription_id, period_month)
);

CREATE TABLE subscription_invoices (           -- platform -> clinic billing
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  amount numeric(14,2) NOT NULL,
  status invoice_status NOT NULL DEFAULT 'OPEN',
  issued_at timestamptz, paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  feature_key varchar(100) NOT NULL,
  is_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, feature_key)
);

-- ========================= IDENTITY / RBAC ===========================
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),        -- NULL => super admin
  email varchar(255), phone varchar(20),
  password_hash varchar(255),
  full_name varchar(255), avatar_url text,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX uq_user_tenant_email ON users(tenant_id, email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_superadmin_email ON users(email) WHERE tenant_id IS NULL AND deleted_at IS NULL;

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),        -- NULL => system role
  name varchar(100) NOT NULL, slug varchar(100) NOT NULL,
  description text, is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX uq_role_tenant_slug ON roles(tenant_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL, slug varchar(100) NOT NULL UNIQUE,
  module varchar(100), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);
CREATE TABLE role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE (role_id, permission_id)
);
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash varchar(255) NOT NULL, device_info text, ip_address varchar(45),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash varchar(255) NOT NULL, expires_at timestamptz NOT NULL,
  used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE branch_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, user_id)
);

-- ============================== AUDIT ================================
CREATE TABLE audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid, user_id uuid,
  action varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL, entity_id uuid,
  old_values jsonb, new_values jsonb, ip_address varchar(45),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ix_audit_tenant ON audit_logs(tenant_id, created_at);
CREATE INDEX ix_audit_entity ON audit_logs(entity_type, entity_id);
CREATE TABLE audit_logs_2026_06 PARTITION OF audit_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- ================================ CRM ================================
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  full_name varchar(255), phone varchar(20) NOT NULL,
  whatsapp_id varchar(100), whatsapp_name varchar(255),
  email varchar(255), gender varchar(10), date_of_birth date,
  source varchar(50), marketing_opt_in boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz, deleted_at timestamptz
);
CREATE UNIQUE INDEX uq_customer_tenant_phone ON customers(tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX ix_customer_dob ON customers(tenant_id, date_of_birth);
CREATE INDEX ix_customer_name_trgm ON customers USING gin (full_name gin_trgm_ops);

CREATE TABLE customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE REFERENCES customers(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  medical_history text, allergies text, blood_type varchar(10),
  emergency_contact_name varchar(255), emergency_contact_phone varchar(20),
  notes text, updated_at timestamptz
);
CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id), tenant_id uuid NOT NULL REFERENCES tenants(id),
  label varchar(50), address_line text, city varchar(100), is_default boolean NOT NULL DEFAULT false
);
CREATE TABLE customer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id), tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid REFERENCES users(id), content text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(100) NOT NULL, color varchar(7), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE customer_tag_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES customer_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, tag_id)
);
CREATE TABLE customer_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id), tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_name varchar(255), file_url text, file_type varchar(50),
  uploaded_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);

-- ========================== SERVICES =================================
CREATE TABLE service_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(255) NOT NULL, description text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  category_id uuid REFERENCES service_categories(id),
  name varchar(255) NOT NULL, description text,
  duration_minutes int NOT NULL CHECK (duration_minutes > 0),
  pricing_type pricing_type NOT NULL DEFAULT 'FIXED',
  base_price numeric(14,2) CHECK (base_price IS NULL OR base_price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz, deleted_at timestamptz
);
CREATE INDEX ix_service_tenant ON services(tenant_id, is_active) WHERE deleted_at IS NULL;
CREATE TABLE service_prices (             -- per-branch price override
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  price numeric(14,2) NOT NULL CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, branch_id)
);
CREATE TABLE service_resources (          -- rooms / equipment
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(255), type varchar(50), created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================ STAFF ==================================
CREATE TABLE staff_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title varchar(100), bio text, avatar_url text,
  booking_buffer_minutes int NOT NULL DEFAULT 0,
  is_available_for_booking boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX ix_staff_tenant ON staff_profiles(tenant_id) WHERE deleted_at IS NULL;
CREATE TABLE staff_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, service_id)
);
CREATE TABLE staff_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL, end_time time NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CHECK (end_time > start_time)
);
CREATE INDEX ix_staff_sched ON staff_schedules(staff_id, day_of_week);
CREATE TABLE working_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id), tenant_id uuid NOT NULL REFERENCES tenants(id),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL, end_time time NOT NULL, is_closed boolean NOT NULL DEFAULT false
);
CREATE TABLE staff_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  start_date date NOT NULL, end_date date NOT NULL, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK (end_date >= start_date)
);
CREATE TABLE staff_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  service_id uuid REFERENCES services(id),
  commission_type varchar(20) NOT NULL CHECK (commission_type IN ('PERCENT','FIXED')),
  commission_value numeric(14,2) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE staff_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid REFERENCES customers(id), appointment_id uuid,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text, created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== SCHEDULING / SLOTS ============================
CREATE TABLE calendar_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id),
  start_time timestamptz NOT NULL, end_time timestamptz NOT NULL,
  is_available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  -- a staff member can never have two overlapping slots
  CONSTRAINT no_slot_overlap EXCLUDE USING gist (
    staff_id WITH =, tstzrange(start_time, end_time, '[)') WITH &&
  )
);
CREATE INDEX ix_slot_lookup ON calendar_slots(tenant_id, branch_id, staff_id, start_time)
  WHERE is_available = true;
CREATE TABLE blocked_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid REFERENCES branches(id), staff_id uuid REFERENCES staff_profiles(id),
  start_time timestamptz NOT NULL, end_time timestamptz NOT NULL, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK (end_time > start_time)
);
CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id),
  name varchar(255), date date NOT NULL, is_recurring boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========================= APPOINTMENTS ==============================
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id),
  slot_id uuid REFERENCES calendar_slots(id),
  -- denormalized authoritative time window (source of truth for conflict guard)
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  status appointment_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  total_amount numeric(14,2), currency char(3) NOT NULL DEFAULT 'USD',
  notes text, source appointment_source NOT NULL DEFAULT 'WHATSAPP_BOT',
  booked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz, deleted_at timestamptz,
  CHECK (end_at > start_at),
  -- one appointment per physical slot (defensive, alongside slot reservation)
  CONSTRAINT uq_slot_once UNIQUE (slot_id),
  -- *** DB-LEVEL DOUBLE-BOOKING GUARANTEE ***
  CONSTRAINT no_staff_overlap EXCLUDE USING gist (
    staff_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status NOT IN ('CANCELLED','NO_SHOW') AND deleted_at IS NULL)
);
CREATE INDEX ix_appt_branch_time ON appointments(tenant_id, branch_id, start_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_appt_staff_time  ON appointments(staff_id, start_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_appt_customer    ON appointments(customer_id, start_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_appt_status      ON appointments(tenant_id, status) WHERE deleted_at IS NULL;

CREATE TABLE appointment_services (    -- multi-service per appointment (M:N)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  price numeric(14,2) NOT NULL, duration_minutes int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_apptsvc ON appointment_services(appointment_id);

CREATE TABLE appointment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  changed_by uuid, old_status appointment_status, new_status appointment_status,
  note text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_appt_hist ON appointment_history(appointment_id, created_at);
CREATE TABLE appointment_status_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status appointment_status NOT NULL, triggered_by varchar(20),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appointment_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid,
  content text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appointment_reschedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  old_slot_id uuid, new_slot_id uuid, reason text, rescheduled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appointment_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  reason text, cancelled_by uuid, refund_amount numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  appointment_id uuid UNIQUE REFERENCES appointments(id),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text, reply text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX ix_review_rating ON customer_reviews(tenant_id, rating) WHERE deleted_at IS NULL;

-- =========================== PAYMENTS ================================
CREATE TABLE payment_gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),   -- NULL => platform-level gateway
  gateway_name varchar(50) NOT NULL, is_active boolean NOT NULL DEFAULT true,
  config jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid REFERENCES branches(id),   -- ADDED: revenue attribution
  appointment_id uuid REFERENCES appointments(id),
  customer_id uuid REFERENCES customers(id),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency varchar(10) NOT NULL DEFAULT 'USD',
  status payment_status NOT NULL DEFAULT 'PENDING',
  gateway varchar(50), gateway_payment_id varchar(255),
  settlement_status settlement_status_t NOT NULL DEFAULT 'UNSETTLED',  -- ADDED
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz, deleted_at timestamptz
);
CREATE UNIQUE INDEX uq_gateway_payment ON payments(gateway, gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;     -- webhook idempotency
CREATE INDEX ix_pay_status ON payments(tenant_id, status);
CREATE INDEX ix_pay_branch_rev ON payments(tenant_id, branch_id, paid_at) WHERE status = 'PAID';
CREATE INDEX ix_pay_unsettled ON payments(tenant_id, paid_at)
  WHERE status = 'PAID' AND settlement_status = 'UNSETTLED';

CREATE TABLE payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  appointment_id uuid REFERENCES appointments(id),
  amount numeric(14,2) NOT NULL, link_token varchar(255) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE', expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  gateway_transaction_id varchar(255), type varchar(20) NOT NULL,  -- CHARGE/REFUND/AUTH
  amount numeric(14,2) NOT NULL, status varchar(20) NOT NULL,
  raw_response jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_txn_payment ON transactions(payment_id);
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reason text, status varchar(20) NOT NULL DEFAULT 'PENDING', processed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoices (                 -- customer-facing invoices
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  appointment_id uuid REFERENCES appointments(id),
  customer_id uuid REFERENCES customers(id),
  invoice_number varchar(50) NOT NULL,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  status invoice_status NOT NULL DEFAULT 'DRAFT',
  issued_at timestamptz, paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (tenant_id, invoice_number)
);
CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  description varchar(255) NOT NULL, quantity int NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL, total_price numeric(14,2) NOT NULL
);

-- ====================== SETTLEMENTS (ADDED) ==========================
CREATE TABLE settlements (              -- platform -> clinic payouts
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid REFERENCES branches(id),
  period_start date, period_end date,
  gross_amount numeric(14,2) NOT NULL DEFAULT 0,
  fee_amount numeric(14,2) NOT NULL DEFAULT 0,
  net_amount numeric(14,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  status payout_status NOT NULL DEFAULT 'PENDING', paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz
);
CREATE INDEX ix_settle_status ON settlements(tenant_id, status);
CREATE TABLE settlement_items (
  settlement_id uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),  -- a payment settles once
  PRIMARY KEY (settlement_id, payment_id)
);

-- ========================= WHATSAPP =================================
CREATE TABLE whatsapp_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL UNIQUE REFERENCES branches(id),   -- 1 number / branch
  phone_number_id varchar(100), waba_id varchar(100),
  access_token text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id),
  name varchar(100) NOT NULL, language varchar(10) NOT NULL, category varchar(50),
  status varchar(20) NOT NULL DEFAULT 'PENDING', components jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (tenant_id, name, language)
);
CREATE TABLE whatsapp_webhooks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id), event_type varchar(100),
  payload jsonb, processed boolean NOT NULL DEFAULT false,
  idempotency_key varchar(255), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE UNIQUE INDEX uq_wa_webhook_idem ON whatsapp_webhooks(idempotency_key, created_at)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE whatsapp_webhooks_2026_06 PARTITION OF whatsapp_webhooks FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE whatsapp_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid REFERENCES customers(id),
  wa_id varchar(100), display_name varchar(255), created_at timestamptz NOT NULL DEFAULT now()
);

-- ====================== CONVERSATIONS / MESSAGES =====================
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid REFERENCES branches(id),
  customer_id uuid REFERENCES customers(id),
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id),
  status conversation_status NOT NULL DEFAULT 'BOT',
  type varchar(20), assigned_to uuid REFERENCES users(id),
  last_message_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_conv_customer ON conversations(tenant_id, customer_id);
CREATE INDEX ix_conv_status   ON conversations(tenant_id, status);
CREATE TABLE conversation_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id), joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, user_id)
);
CREATE TABLE messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sender_type msg_sender_type NOT NULL, sender_id uuid,
  content text, message_type varchar(20) NOT NULL DEFAULT 'text',
  wa_message_id varchar(255), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ix_msg_conv ON messages(conversation_id, created_at);
CREATE INDEX ix_msg_tenant ON messages(tenant_id, created_at);
CREATE TABLE messages_2026_06 PARTITION OF messages FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_url text, file_type varchar(50), file_name varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE message_status_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id),
  status varchar(20) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================ AI / RAG ===============================
CREATE TABLE ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id),
  name varchar(255), model varchar(100), system_prompt text,
  temperature numeric(3,2) NOT NULL DEFAULT 0.20,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE ai_knowledge_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_id uuid REFERENCES ai_agents(id) ON DELETE CASCADE,
  content text, embedding vector(1536),
  source_type varchar(50), source_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
-- vector ANN index for RAG retrieval (cosine)
CREATE INDEX ix_kb_embedding ON ai_knowledge_bases
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ix_kb_tenant ON ai_knowledge_bases(tenant_id, agent_id);
CREATE TABLE ai_training_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), agent_id uuid REFERENCES ai_agents(id),
  file_name varchar(255), file_url text, file_type varchar(20),
  status varchar(20) NOT NULL DEFAULT 'PENDING', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), agent_id uuid REFERENCES ai_agents(id),
  name varchar(100), content text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid REFERENCES conversations(id),
  agent_id uuid REFERENCES ai_agents(id),
  status varchar(20) NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ai_conversation_id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id),
  role varchar(20) NOT NULL, content text, tokens_used int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ix_aimsg_conv ON ai_messages(ai_conversation_id, created_at);
CREATE TABLE ai_messages_2026_06 PARTITION OF ai_messages FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), agent_id uuid REFERENCES ai_agents(id),
  period_month varchar(7) NOT NULL, total_tokens bigint NOT NULL DEFAULT 0,
  total_requests int NOT NULL DEFAULT 0, updated_at timestamptz,
  UNIQUE (tenant_id, agent_id, period_month)
);
CREATE TABLE ai_cost_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), period_month varchar(7) NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
  total_cost_usd numeric(14,6) NOT NULL DEFAULT 0, updated_at timestamptz,
  UNIQUE (tenant_id, period_month)
);
CREATE TABLE handover_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  reason text, status handover_status NOT NULL DEFAULT 'PENDING',
  assigned_to uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE INDEX ix_handover_open ON handover_requests(tenant_id) WHERE status IN ('PENDING','ASSIGNED');

-- =================== CAMPAIGNS (ADDED) ===============================
CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type campaign_type NOT NULL, name varchar(200) NOT NULL,
  template_id uuid REFERENCES whatsapp_templates(id),
  status campaign_status NOT NULL DEFAULT 'DRAFT',
  segment jsonb,                              -- tag/age/inactivity rules
  scheduled_at timestamptz,
  throttle_per_minute int NOT NULL DEFAULT 30 CHECK (throttle_per_minute > 0),
  daily_cap int, monthly_cap int,            -- anti-spam controls
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz,
  created_by uuid, deleted_at timestamptz
);
CREATE INDEX ix_campaign_status ON campaigns(tenant_id, status) WHERE deleted_at IS NULL;
CREATE TABLE campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  status recipient_status NOT NULL DEFAULT 'QUEUED', sent_at timestamptz,
  UNIQUE (campaign_id, customer_id)
);
CREATE INDEX ix_camprec_queue ON campaign_recipients(campaign_id) WHERE status = 'QUEUED';

-- ===================== NOTIFICATIONS / FOLLOW-UP =====================
CREATE TABLE notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  name varchar(100) NOT NULL, type varchar(50), channel varchar(20),
  content_ar text, content_en text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_rules (        -- e.g. completed+360min => feedback
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  template_id uuid REFERENCES notification_templates(id),
  trigger_event varchar(100) NOT NULL,   -- booking_created / before_24h / before_6h / before_1h / payment_pending / appointment_completed
  delay_minutes int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scheduled_notifications (   -- the outbox / follow-up queue
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  template_id uuid REFERENCES notification_templates(id),
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  recipient_type varchar(20), recipient_id uuid,
  scheduled_at timestamptz NOT NULL,
  status notification_status NOT NULL DEFAULT 'SCHEDULED',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sched_due ON scheduled_notifications(scheduled_at) WHERE status = 'SCHEDULED';
CREATE TABLE notification_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  template_id uuid, recipient_type varchar(20), recipient_id uuid,
  channel varchar(20), status varchar(20), error_message text,
  sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE notification_logs_2026_06 PARTITION OF notification_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- ===================== ANALYTICS / REPORTING =========================
CREATE TABLE analytics_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id),
  event_type varchar(100), entity_type varchar(50), entity_id uuid,
  metadata jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE analytics_events_2026_06 PARTITION OF analytics_events FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE daily_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id),
  date date NOT NULL, total_appointments int NOT NULL DEFAULT 0,
  completed_appointments int NOT NULL DEFAULT 0, cancelled_appointments int NOT NULL DEFAULT 0,
  total_revenue numeric(14,2) NOT NULL DEFAULT 0, new_customers int NOT NULL DEFAULT 0,
  ai_messages_count int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, date)
);
CREATE TABLE monthly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id),
  period_month varchar(7) NOT NULL, total_appointments int NOT NULL DEFAULT 0,
  total_revenue numeric(14,2) NOT NULL DEFAULT 0, avg_rating numeric(3,2),
  top_services jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, period_month)
);
CREATE TABLE dashboard_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id),
  metric_key varchar(100) NOT NULL, metric_value numeric(20,4), period varchar(20),
  updated_at timestamptz
);

-- ==================== PLATFORM / INTEGRATION =========================
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(100), key_hash varchar(255) NOT NULL UNIQUE, permissions jsonb,
  last_used_at timestamptz, expires_at timestamptz, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id), endpoint varchar(255), method varchar(10),
  status_code smallint, response_time_ms int, ip_address varchar(45),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE api_logs_2026_06 PARTITION OF api_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE webhook_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id), source varchar(50), event_type varchar(100),
  payload jsonb, status varchar(20), error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE webhook_logs_2026_06 PARTITION OF webhook_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE file_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id), uploaded_by uuid,
  file_name varchar(255), file_url text, file_type varchar(50), file_size bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(120) NOT NULL UNIQUE, value jsonb, updated_at timestamptz
);

-- =================== ROW-LEVEL SECURITY (sample) =====================
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_appt ON appointments
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
-- replicate the same policy on every tenant-scoped table; super-admin role uses BYPASSRLS.

-- =================== REPORTING MATERIALIZED VIEW =====================
CREATE MATERIALIZED VIEW mv_revenue_by_branch_daily AS
SELECT tenant_id, branch_id, date_trunc('day', paid_at) AS day, currency,
       count(*) AS payments_count, sum(amount) AS gross_revenue
FROM payments WHERE status = 'PAID' AND deleted_at IS NULL
GROUP BY tenant_id, branch_id, date_trunc('day', paid_at), currency;
CREATE UNIQUE INDEX uq_mv_rev ON mv_revenue_by_branch_daily(tenant_id, branch_id, day, currency);

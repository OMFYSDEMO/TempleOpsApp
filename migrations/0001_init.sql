-- AVOS schema v1. Money is INTEGER paise. Dates are ISO text (YYYY-MM-DD) in the property's timezone.
-- Every table carries property_id so the SaaS turn is configuration, not migration.

CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  address TEXT,
  gstin TEXT,                       -- NULL until registered: invoices then carry no GST (F2)
  state_code TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  fy_start_month INTEGER NOT NULL DEFAULT 4,
  invoice_prefix TEXT NOT NULL,     -- e.g. MV
  gst_threshold_paise INTEGER NOT NULL DEFAULT 750000,  -- per room-night declared tariff (F2)
  gst_rate_below_bp INTEGER NOT NULL DEFAULT 500,       -- 5.00% without ITC
  gst_rate_above_bp INTEGER NOT NULL DEFAULT 1800,      -- 18.00% with ITC
  auto_approve_on_tariff INTEGER NOT NULL DEFAULT 1,    -- approval by exception (F3)
  auto_approve_max_rooms INTEGER NOT NULL DEFAULT 4,
  quote_valid_hours INTEGER NOT NULL DEFAULT 48,
  hold_hours INTEGER NOT NULL DEFAULT 48,
  lead_nudge_minutes INTEGER NOT NULL DEFAULT 15,
  lead_escalate_minutes INTEGER NOT NULL DEFAULT 60,
  recon_fee_tolerance_bp INTEGER NOT NULL DEFAULT 300,  -- tier 3: ±3.00%
  recon_subset_tolerance_bp INTEGER NOT NULL DEFAULT 150, -- tier 4: ±1.50%
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('sales','property','revenue','owner','accountant')),
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX users_email ON users(email);
CREATE INDEX users_property ON users(property_id);

-- Rooms and common areas share one table so tasks can point at either.
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL CHECK (kind IN ('room','area')),
  code TEXT NOT NULL,              -- R1..R4, LIV-G, GARDEN
  name TEXT NOT NULL,              -- Deluxe, Premium, Garden
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX locations_code ON locations(property_id, code);

-- Tariff card: the rate a room should sell at on a date. Overlaps resolved by highest priority.
CREATE TABLE rate_cards (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  room_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,              -- Standard, Peak
  rate_paise INTEGER NOT NULL,     -- ex-GST per night
  from_date TEXT,                  -- NULL = always
  to_date TEXT,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX rate_cards_room ON rate_cards(property_id, room_id, from_date, to_date);

-- OTA / channel configuration. The payout formula reads every rate from here (F5).
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  code TEXT NOT NULL,              -- direct, booking_com, swiftbook, airbnb
  name TEXT NOT NULL,
  collection_type TEXT NOT NULL CHECK (collection_type IN ('direct','channel_collect','hotel_collect')),
  commission_bp INTEGER NOT NULL DEFAULT 0,
  commission_base TEXT NOT NULL DEFAULT 'ex_gst' CHECK (commission_base IN ('ex_gst','gross')),
  payment_fee_bp INTEGER NOT NULL DEFAULT 0,
  payment_fee_base TEXT NOT NULL DEFAULT 'gross' CHECK (payment_fee_base IN ('ex_gst','gross')),
  tcs_bp INTEGER NOT NULL DEFAULT 0,      -- GST s.52 TCS deducted by the operator
  tds_bp INTEGER NOT NULL DEFAULT 0,      -- IT s.194-O TDS deducted by the operator
  tcs_base TEXT NOT NULL DEFAULT 'ex_gst',
  tds_base TEXT NOT NULL DEFAULT 'gross',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX channels_code ON channels(property_id, code);

-- Money accounts: the cash ledger (F6). Bank is the owner's; petty cash is the property manager's.
CREATE TABLE money_accounts (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL CHECK (kind IN ('bank','cash','petty_cash','gateway','ota_clearing')),
  name TEXT NOT NULL,
  holder_role TEXT NOT NULL,       -- who may record movements: owner | property
  opening_paise INTEGER NOT NULL DEFAULT 0,
  opening_date TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX money_accounts_property ON money_accounts(property_id);

CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  phone TEXT,                      -- identity key (F9); normalised E.164 digits
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX guests_phone ON guests(property_id, phone);
CREATE INDEX guests_name ON guests(property_id, name);

-- Leads: exactly five statuses; expiry is a reason, not a status (F8).
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  guest_id TEXT REFERENCES guests(id),
  source TEXT NOT NULL,            -- instagram, facebook, website, whatsapp, phone, walkin, other
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','quoted','hold','won','lost')),
  check_in TEXT, check_out TEXT,
  rooms_wanted INTEGER NOT NULL DEFAULT 1,
  adults INTEGER NOT NULL DEFAULT 2,
  children INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  assigned_to TEXT REFERENCES users(id),
  quote_json TEXT,                 -- composed quote lines (room, nights, rate, gst)
  quote_total_paise INTEGER,
  quote_expires_at TEXT,
  hold_expires_at TEXT,
  lost_reason TEXT,                -- dates, price, no_reply, expired, other
  booking_id TEXT,
  external_ref TEXT,               -- Meta lead id etc. (dedupe)
  first_response_at TEXT,
  nudged_at TEXT,
  escalated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX leads_status ON leads(property_id, status, created_at);
CREATE UNIQUE INDEX leads_external ON leads(property_id, source, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  guest_id TEXT NOT NULL REFERENCES guests(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  external_ref TEXT,               -- OTA reservation id / itinerary number
  status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (status IN ('provisional','approved','checked_in','checked_out','cancelled','no_show')),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  nights INTEGER NOT NULL,
  adults INTEGER NOT NULL DEFAULT 2,
  children INTEGER NOT NULL DEFAULT 0,
  room_total_paise INTEGER NOT NULL,   -- ex-GST
  gst_paise INTEGER NOT NULL,
  gross_paise INTEGER NOT NULL,
  rate_vs_tariff TEXT NOT NULL DEFAULT 'on' CHECK (rate_vs_tariff IN ('on','below','above','no_tariff')),
  approval_mode TEXT,                   -- auto_on_tariff | manual
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  salesperson_id TEXT REFERENCES users(id),
  lead_id TEXT REFERENCES leads(id),
  inbox_item_id TEXT,
  books_date TEXT NOT NULL,             -- revenue date = check-out (F12)
  checked_in_at TEXT, checked_out_at TEXT,
  cancelled_at TEXT, cancel_reason TEXT,
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX bookings_dates ON bookings(property_id, check_in, check_out);
CREATE INDEX bookings_status ON bookings(property_id, status);
CREATE INDEX bookings_books_date ON bookings(property_id, books_date);
CREATE UNIQUE INDEX bookings_external ON bookings(property_id, channel_id, external_ref) WHERE external_ref IS NOT NULL;

-- One line per room on a booking; GST slab computed per line from the nightly tariff (F2).
CREATE TABLE booking_rooms (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  room_id TEXT NOT NULL REFERENCES locations(id),
  nightly_rate_paise INTEGER NOT NULL,  -- ex-GST, as sold
  tariff_rate_paise INTEGER,            -- from rate card, for the rate_vs_tariff check
  gst_rate_bp INTEGER NOT NULL,
  nights INTEGER NOT NULL,
  room_total_paise INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL
);
CREATE INDEX booking_rooms_booking ON booking_rooms(booking_id);

-- Inventory (F1): one row per room per night. Holds and bookings both occupy it; the unique index is the double-booking guard.
CREATE TABLE room_nights (
  property_id TEXT NOT NULL REFERENCES properties(id),
  room_id TEXT NOT NULL REFERENCES locations(id),
  night TEXT NOT NULL,                  -- YYYY-MM-DD, night of stay
  kind TEXT NOT NULL CHECK (kind IN ('booked','hold')),
  booking_id TEXT REFERENCES bookings(id),
  lead_id TEXT REFERENCES leads(id),
  expires_at TEXT,                      -- holds only
  PRIMARY KEY (property_id, room_id, night)
);
CREATE INDEX room_nights_booking ON room_nights(booking_id);
CREATE INDEX room_nights_lead ON room_nights(lead_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  booking_id TEXT REFERENCES bookings(id),
  guest_id TEXT REFERENCES guests(id),
  kind TEXT NOT NULL CHECK (kind IN ('advance','balance','refund')),
  method TEXT NOT NULL CHECK (method IN ('upi','cash','card','airpay','bank','ota')),
  amount_paise INTEGER NOT NULL,         -- positive; refunds are kind='refund'
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  reference TEXT,                        -- UTR / order id / last-4
  received_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','confirmed','matched','void')),
  fee_expense_id TEXT,                   -- the ONE fee expense this payment created (F4)
  inbox_item_id TEXT,
  refund_approval_id TEXT,
  recorded_by TEXT REFERENCES users(id),
  idempotency_key TEXT,
  voided_at TEXT, void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX payments_booking ON payments(booking_id);
CREATE INDEX payments_date ON payments(property_id, received_on);
CREATE INDEX payments_reference ON payments(property_id, reference);
CREATE UNIQUE INDEX payments_idem ON payments(property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Transfers between money accounts: cash deposit to bank, petty-cash top-up (F6). Never an expense.
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  from_account_id TEXT NOT NULL REFERENCES money_accounts(id),
  to_account_id TEXT NOT NULL REFERENCES money_accounts(id),
  amount_paise INTEGER NOT NULL,
  on_date TEXT NOT NULL,
  reference TEXT,
  note TEXT,
  recorded_by TEXT REFERENCES users(id),
  idempotency_key TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX transfers_date ON transfers(property_id, on_date);
CREATE UNIQUE INDEX transfers_idem ON transfers(property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL DEFAULT 'normal'
    CHECK (kind IN ('normal','gateway_fee','ota_commission','ota_payment_fee','fee_variance')),
  category TEXT NOT NULL,                -- repairs, fnb, housekeeping, amenities, utilities, subscriptions, professional, marketing, misc
  description TEXT,
  vendor_name TEXT,
  vendor_gstin TEXT,
  bill_no TEXT,
  bill_date TEXT,
  amount_paise INTEGER NOT NULL,         -- inclusive of GST
  gst_rate_bp INTEGER NOT NULL DEFAULT 0,
  gst_paise INTEGER NOT NULL DEFAULT 0,  -- recorded for the register; not creditable at the 5% slab
  paid_from_account_id TEXT REFERENCES money_accounts(id),
  on_date TEXT NOT NULL,
  reference TEXT,
  bill_photo_key TEXT,
  task_id TEXT,
  payment_id TEXT,                       -- fee expenses link to their payment
  settlement_id TEXT,                    -- fee/commission expenses link to their settlement
  recorded_by TEXT REFERENCES users(id),
  idempotency_key TEXT,
  voided_at TEXT, void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX expenses_date ON expenses(property_id, on_date);
CREATE INDEX expenses_payment ON expenses(payment_id);
CREATE INDEX expenses_settlement ON expenses(settlement_id);
CREATE UNIQUE INDEX expenses_idem ON expenses(property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Sequential numbering per property per financial year, incremented in the same batch as the insert (F13).
CREATE TABLE sequences (
  property_id TEXT NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,                    -- invoice, credit_note
  fy TEXT NOT NULL,                      -- 26-27
  next INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (property_id, name, fy)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  number TEXT NOT NULL,                  -- MV/26-27/004
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  issued_on TEXT NOT NULL,
  guest_name TEXT NOT NULL, guest_phone TEXT, guest_gstin TEXT,
  lines_json TEXT NOT NULL,
  taxable_paise INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  received_paise INTEGER NOT NULL,
  balance_paise INTEGER NOT NULL,
  gst_applicable INTEGER NOT NULL,       -- 0 when property has no GSTIN at issue time
  pdf_key TEXT,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','credited')),
  issued_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX invoices_number ON invoices(property_id, number);
CREATE INDEX invoices_booking ON invoices(booking_id);
CREATE INDEX invoices_issued ON invoices(property_id, issued_on);

CREATE TABLE credit_notes (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  number TEXT NOT NULL,                  -- MV/CN/26-27/001
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  issued_on TEXT NOT NULL,
  taxable_paise INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  reason TEXT NOT NULL,
  refund_payment_id TEXT,
  issued_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX credit_notes_number ON credit_notes(property_id, number);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  kind TEXT NOT NULL CHECK (kind IN ('housekeeping','maintenance','repair','note')),
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','noted')),
  due_on TEXT,
  photo_key TEXT,
  booking_id TEXT,
  assigned_to TEXT REFERENCES users(id),
  expense_id TEXT,                       -- repair bill posted from Done (W8)
  created_by TEXT REFERENCES users(id),
  idempotency_key TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX tasks_status ON tasks(property_id, status, due_on);
CREATE UNIQUE INDEX tasks_idem ON tasks(property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  source TEXT NOT NULL,                  -- staah, swiftbook, airpay, unknown
  kind TEXT NOT NULL,                    -- new_reservation, modification, cancellation, payment, unknown
  message_id TEXT,
  from_addr TEXT, subject TEXT,
  received_at TEXT NOT NULL,
  raw_key TEXT,                          -- R2 key of the .eml
  parsed_json TEXT,                      -- parser output; NULL when unparsed
  parser_version TEXT,
  external_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed','duplicate','routed')),
  booking_id TEXT, payment_id TEXT,
  reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX inbox_status ON inbox_items(property_id, status, received_at);
CREATE UNIQUE INDEX inbox_message ON inbox_items(property_id, message_id) WHERE message_id IS NOT NULL;

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  payout_ref TEXT NOT NULL,
  payout_on TEXT,
  gross_paise INTEGER NOT NULL,
  commission_paise INTEGER NOT NULL,
  payment_fee_paise INTEGER NOT NULL,
  tcs_paise INTEGER NOT NULL,
  tds_paise INTEGER NOT NULL,
  expected_paise INTEGER NOT NULL,       -- gross − commission − fee − tcs − tds
  received_paise INTEGER,                -- what the bank shows; NULL until matched
  variance_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','settled','undone')),
  approval_id TEXT,
  created_by TEXT REFERENCES users(id),
  settled_by TEXT REFERENCES users(id), settled_at TEXT,
  undone_by TEXT REFERENCES users(id), undone_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX settlements_ref ON settlements(property_id, channel_id, payout_ref);

CREATE TABLE settlement_items (
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  gross_paise INTEGER NOT NULL,
  commission_paise INTEGER NOT NULL,
  payment_fee_paise INTEGER NOT NULL,
  tcs_paise INTEGER NOT NULL,
  tds_paise INTEGER NOT NULL,
  net_paise INTEGER NOT NULL,
  PRIMARY KEY (settlement_id, booking_id)
);

-- Recoverable statutory credits created by settlements (TCS to accept on the GST portal, TDS for 26AS).
CREATE TABLE statutory_credits (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL CHECK (kind IN ('tcs','tds')),
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  amount_paise INTEGER NOT NULL,
  period TEXT NOT NULL,                  -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','claimed','reversed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX statutory_period ON statutory_credits(property_id, period);

CREATE TABLE bank_statement_lines (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  run_id TEXT NOT NULL,
  on_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,         -- signed: credit > 0, debit < 0
  reference TEXT,
  line_hash TEXT NOT NULL,               -- dedupe across pastes
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','proposed','matched','carried')),
  tier INTEGER,                          -- 1 UTR, 2 exact, 3 fee-tolerant, 4 OTA subset
  match_kind TEXT,                       -- payment, transfer, settlement, expense
  match_id TEXT,
  match_json TEXT,                       -- proposal detail (implied fee, subset ids)
  reason TEXT,
  matched_by TEXT REFERENCES users(id), matched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX bank_lines_hash ON bank_statement_lines(property_id, account_id, line_hash);
CREATE INDEX bank_lines_status ON bank_statement_lines(property_id, status, on_date);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL CHECK (kind IN ('booking','settlement','refund','recon','preclose')),
  ref_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  amount_paise INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','returned','auto')),
  requested_by TEXT REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX approvals_status ON approvals(property_id, status, created_at);

-- Month state machine: open → precleared → locked → filed; unlock creates the next pack version (W9/W10).
CREATE TABLE period_locks (
  property_id TEXT NOT NULL REFERENCES properties(id),
  period TEXT NOT NULL,                  -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','precleared','locked','filed')),
  version INTEGER NOT NULL DEFAULT 0,
  precleared_by TEXT, precleared_at TEXT,
  locked_by TEXT, locked_at TEXT,
  filed_by TEXT, filed_at TEXT,
  unlocked_by TEXT, unlocked_at TEXT, unlock_reason TEXT,
  PRIMARY KEY (property_id, period)
);

CREATE TABLE statement_packs (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  period TEXT NOT NULL,
  version INTEGER NOT NULL,
  revised INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  keys_json TEXT NOT NULL,               -- R2 keys of PDF/CSV files
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX packs_version ON statement_packs(property_id, period, version);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,                  -- booking.create, payment.void, period.lock ...
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_entity ON audit_log(property_id, entity, entity_id);
CREATE INDEX audit_at ON audit_log(property_id, at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                    -- lead_nudge, lead_escalation, approval_pending, hold_expired ...
  ref_kind TEXT, ref_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, read_at, created_at);

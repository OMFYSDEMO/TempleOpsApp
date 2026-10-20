-- Proof of identity for guests: photographed at the front desk, kept privately in R2 while the guest is
-- in house, moved to the owner's Google Drive 48 hours after the stay ends. Foreign nationals also need
-- Form C (FRRO) filed within 24 hours of arrival; sales files it and records the acknowledgement.
CREATE TABLE guest_documents (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  person_name TEXT NOT NULL,              -- the person on the document (a stay can have several guests)
  nationality TEXT NOT NULL CHECK (nationality IN ('indian','foreign')),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('aadhaar','passport','driving_licence','voter_id','visa','arrival_stamp','other')),
  note TEXT,
  r2_key TEXT,                            -- NULL once moved to Drive
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  captured_by TEXT NOT NULL REFERENCES users(id),
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  drive_file_id TEXT,
  drive_link TEXT,
  archived_at TEXT,
  deleted_at TEXT
);
CREATE INDEX guest_documents_booking ON guest_documents(booking_id, deleted_at);
CREATE INDEX guest_documents_archive ON guest_documents(property_id, archived_at, deleted_at);

ALTER TABLE bookings ADD COLUMN guest_nationality TEXT NOT NULL DEFAULT 'indian' CHECK (guest_nationality IN ('indian','foreign'));
ALTER TABLE bookings ADD COLUMN form_c_status TEXT NOT NULL DEFAULT 'none' CHECK (form_c_status IN ('none','due','filed'));
ALTER TABLE bookings ADD COLUMN form_c_reference TEXT;
ALTER TABLE bookings ADD COLUMN form_c_filed_at TEXT;
ALTER TABLE bookings ADD COLUMN form_c_filed_by TEXT;
ALTER TABLE bookings ADD COLUMN ids_archived_at TEXT;       -- when the stay's documents were moved to Drive
ALTER TABLE bookings ADD COLUMN drive_folder_id TEXT;

-- Integrations the owner connects from Settings (today: Google Drive for the ID archive). One row per kind.
CREATE TABLE integrations (
  property_id TEXT NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL,                     -- 'google_drive'
  account_email TEXT,
  refresh_token TEXT NOT NULL,
  folder_id TEXT,                         -- root folder the archive is written under
  folder_link TEXT,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  last_error TEXT,
  PRIMARY KEY (property_id, kind)
);

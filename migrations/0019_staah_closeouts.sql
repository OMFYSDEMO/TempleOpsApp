-- STAAH is the inventory master for every channel, and AVOS only reads it (its emails). A direct booking made by hand in
-- AVOS, or cancelled or moved there, must be mirrored in STAAH by a person: each row is one such update, open until done.
CREATE TABLE staah_closeouts (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  action TEXT NOT NULL CHECK (action IN ('close','reopen')),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  rooms TEXT NOT NULL,
  guest_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_by TEXT REFERENCES users(id),
  done_at TEXT
);
CREATE INDEX staah_closeouts_open ON staah_closeouts(property_id, status, created_at);
CREATE INDEX staah_closeouts_booking ON staah_closeouts(booking_id);

-- A refund asked for when a paid booking is cancelled: why, what Meadows actually received (after gateway and card-machine
-- charges), what the cancellation policy allows, the amount asked, and the guest's bank account to send it to.
CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  approval_id TEXT,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('guest_cancelled','date_change','overbooking','hotel_cancelled','no_show','other')),
  reason_note TEXT,
  days_before_arrival INTEGER,
  paid_paise INTEGER NOT NULL,
  charges_paise INTEGER NOT NULL,
  net_received_paise INTEGER NOT NULL,
  policy_refund_paise INTEGER NOT NULL,
  refund_paise INTEGER NOT NULL,
  above_policy_reason TEXT,
  payee_name TEXT, account_no TEXT, ifsc TEXT, bank_name TEXT,
  requested_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX refund_requests_booking ON refund_requests(booking_id);
CREATE INDEX refund_requests_approval ON refund_requests(approval_id);

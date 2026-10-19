-- Other income: money the property earns outside room stays (meals for day guests, photoshoots, events).
-- Recorded inclusive of GST with the slab split out, paid into a money account, so it reaches the cash
-- ledger, the revenue overview, the P&L and the GST filing sheet like a stay does.
CREATE TABLE other_income (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  on_date TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('dining','photo','events','transport','other')),
  description TEXT NOT NULL,
  payer_name TEXT,
  amount_paise INTEGER NOT NULL,          -- inclusive of GST
  gst_rate_bp INTEGER NOT NULL DEFAULT 0,
  gst_paise INTEGER NOT NULL DEFAULT 0,
  taxable_paise INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('upi','cash','card','airpay','bank')),
  account_id TEXT NOT NULL REFERENCES money_accounts(id),
  reference TEXT,
  recorded_by TEXT REFERENCES users(id),
  idempotency_key TEXT,
  voided_at TEXT, void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX other_income_date ON other_income(property_id, on_date);

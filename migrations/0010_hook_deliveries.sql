-- Every CRM webhook delivery is kept as received, so the field mapping can be tuned from real payloads
-- and a delivery that produced no lead can be found and replayed.
CREATE TABLE hook_deliveries (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  hook TEXT NOT NULL,                     -- 'crm' | 'neodove'
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL,
  lead_id TEXT,
  outcome TEXT NOT NULL,                  -- created | updated | duplicate | skipped:<reason>
  note TEXT
);
CREATE INDEX hook_deliveries_recent ON hook_deliveries(property_id, received_at);

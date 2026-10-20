-- Work queue escalations: an item that waits past its tolerance is raised once to the next role up and
-- remembered here, so the raise happens once and the slip report can show how long things waited.
CREATE TABLE work_escalations (
  property_id TEXT NOT NULL REFERENCES properties(id),
  item_key TEXT NOT NULL,                -- e.g. inbox:inb_x, approval:apr_y
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  escalated_to TEXT NOT NULL,
  since TEXT NOT NULL,                   -- when the item started waiting
  escalated_at TEXT NOT NULL,
  cleared_at TEXT,                       -- when the item was no longer waiting
  PRIMARY KEY (property_id, item_key)
);
CREATE INDEX work_escalations_open ON work_escalations(property_id, cleared_at, escalated_at);

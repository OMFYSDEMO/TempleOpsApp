-- Equipment inside an area (the kitchen's microwave, oven, fridge, washing machine, water purifier), so a
-- maintenance task can name the machine, and a notes log on tasks for what was seen and done.
CREATE TABLE equipment (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX equipment_location ON equipment(location_id);
ALTER TABLE tasks ADD COLUMN equipment_id TEXT REFERENCES equipment(id);
ALTER TABLE tasks ADD COLUMN notes TEXT;

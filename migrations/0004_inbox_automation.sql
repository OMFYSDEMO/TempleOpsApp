-- Inbox automation (W1): a parsed STAAH / SwiftBook / Airpay email is applied to the books on arrival when the
-- parser is confident and the facts line up (channel known, a free room of that type, a stay for the order).
-- Anything else stays a review card, with the reason on it.
ALTER TABLE properties ADD COLUMN inbox_automation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbox_items ADD COLUMN auto_applied INTEGER NOT NULL DEFAULT 0;   -- 1 when automation booked / cancelled / recorded it
ALTER TABLE inbox_items ADD COLUMN auto_note TEXT;                            -- why automation left it for a person

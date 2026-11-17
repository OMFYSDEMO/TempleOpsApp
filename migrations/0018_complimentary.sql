-- A complimentary stay (influencer collaboration, owner's guest): every room at ₹0, no GST, with the reason recorded.
ALTER TABLE bookings ADD COLUMN complimentary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN comp_reason TEXT;

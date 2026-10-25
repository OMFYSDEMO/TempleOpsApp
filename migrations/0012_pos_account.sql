-- Which bank the card machine (POS) at the property settles into. Card payments land there, net of the
-- bank's charge, the next working day. NULL means the default bank.
ALTER TABLE properties ADD COLUMN pos_account_id TEXT;
